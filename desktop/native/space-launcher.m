// The launcher gives a Space its own Dock identity. The Electron host owns the
// window. A Unix socket represents the lifetime of that window, including while
// it is minimized. EOF also handles an unclean host exit.
#import <AppKit/AppKit.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

@interface SpaceLauncher : NSObject <NSApplicationDelegate>
@property(nonatomic, copy) NSString *space;
@property(nonatomic, copy) NSString *endpoint;
@property(nonatomic, strong) dispatch_source_t connection;
@property(nonatomic, strong) NSTimer *retryTimer;
@property(nonatomic) int fd;
@property(nonatomic) BOOL watchOnly;
@property(nonatomic) BOOL hostRequestedQuit;
@property(nonatomic) BOOL terminationPending;
@end

@implementation SpaceLauncher
- (BOOL)sendCommand:(NSString *)command {
    NSData *message = [[NSString stringWithFormat:@"%@ %@\n", command, self.space] dataUsingEncoding:NSUTF8StringEncoding];
    return send(self.fd, message.bytes, message.length, 0) == (ssize_t)message.length;
}

- (BOOL)connectToHost {
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    const char *endpoint = self.endpoint.fileSystemRepresentation;
    if (!endpoint || strlen(endpoint) >= sizeof(address.sun_path)) return NO;
    strlcpy(address.sun_path, endpoint, sizeof(address.sun_path));
    address.sun_len = SUN_LEN(&address);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd == -1) return NO;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    if (connect(fd, (struct sockaddr *)&address, address.sun_len) == -1) {
        close(fd);
        return NO;
    }
    self.fd = fd;
    if (![self sendCommand:self.watchOnly ? @"watch" : @"open"]) {
        close(fd);
        self.fd = -1;
        return NO;
    }

    self.connection = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)fd, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(self.connection, ^{
        self.hostRequestedQuit = YES;
        if (self.terminationPending) [self finishTermination];
        else [NSApp terminate:nil];
    });
    dispatch_source_set_cancel_handler(self.connection, ^{ close(fd); });
    dispatch_resume(self.connection);
    return YES;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSBundle *bundle = NSBundle.mainBundle;
    self.space = [bundle objectForInfoDictionaryKey:@"ForsionSpaceId"];
    self.endpoint = [bundle objectForInfoDictionaryKey:@"ForsionSpaceSocket"];
    self.fd = -1;
    self.watchOnly = [NSProcessInfo.processInfo.arguments containsObject:@"--watch"];
    if (!self.space.length || !self.endpoint.length) {
        [NSApp terminate:nil];
        return;
    }
    if ([self connectToHost]) return;
    if (self.watchOnly) {
        [NSApp terminate:nil];
        return;
    }

    NSString *link = [NSString stringWithFormat:@"forsion://space/%@?window=standalone", self.space];
    NSString *hostID = [bundle objectForInfoDictionaryKey:@"ForsionSpaceHost"];
    NSURL *installedURL = hostID ? [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:hostID] : nil;
    // Prefer the creating installation while it exists, then resolve moved apps by bundle ID.
    NSString *installed = [bundle objectForInfoDictionaryKey:@"ForsionSpaceHostPath"];
    if (installed && ![[NSBundle bundleWithPath:installed].bundleIdentifier isEqualToString:hostID]) installed = nil;
    NSString *host = installed ?: installedURL.path;
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/open"];
    NSString *profile = [bundle objectForInfoDictionaryKey:@"ForsionSpaceProfile"];
    task.arguments = host && profile.length
        ? @[@"-g", @"-n", @"-a", host, @"--args", [@"--user-data-dir=" stringByAppendingString:profile], link]
        : (host ? @[@"-g", @"-a", host, link] : @[@"-g", link]);
    if (![task launchAndReturnError:NULL]) {
        [NSApp terminate:nil];
        return;
    }
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:45];
    self.retryTimer = [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(NSTimer *timer) {
        if ([self connectToHost]) {
            [timer invalidate];
        } else if (deadline.timeIntervalSinceNow <= 0) {
            [timer invalidate];
            [NSApp terminate:nil];
        }
    }];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
    if (self.fd >= 0) [self sendCommand:@"open"];
    return NO;
}

- (void)finishTermination {
    if (!self.terminationPending) return;
    self.terminationPending = NO;
    [NSApp replyToApplicationShouldTerminate:YES];
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    if (self.hostRequestedQuit || self.fd < 0 || ![self sendCommand:@"close"]) return NSTerminateNow;
    // Also applies to system logout. The host normally closes the connection
    // with the window; never let a stalled host veto system termination.
    self.terminationPending = YES;
    [NSTimer scheduledTimerWithTimeInterval:2 repeats:NO block:^(NSTimer *timer) {
        [self finishTermination];
    }];
    return NSTerminateLater;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self.retryTimer invalidate];
    if (self.connection) dispatch_source_cancel(self.connection);
}
@end

int main(int argc, const char *argv[]) {
    // The host builds and signs a complete bundle before publishing it. macOS
    // can atomically swap directories when refreshing a launcher in place.
    if (argc == 5 && strcmp(argv[1], "--publish-bundle") == 0) {
        unsigned int flags = strcmp(argv[2], "replace") == 0 ? RENAME_SWAP : RENAME_EXCL;
        if (renameatx_np(AT_FDCWD, argv[3], AT_FDCWD, argv[4], flags) == 0) return 0;
        int failure = errno;
        perror("publish Space launcher");
        return failure == EEXIST ? 2 : failure == ENOTSUP ? 3 : 1;
    }
    @autoreleasepool {
        if (argc == 3 && strcmp(argv[1], "--locate") == 0) {
            NSString *identifier = [NSString stringWithUTF8String:argv[2]];
            NSArray<NSURL *> *urls = [NSWorkspace.sharedWorkspace URLsForApplicationsWithBundleIdentifier:identifier];
            NSData *data = [NSJSONSerialization dataWithJSONObject:[urls valueForKey:@"path"] options:0 error:NULL];
            fwrite(data.bytes, 1, data.length, stdout);
            return 0;
        }
        NSApplication *app = NSApplication.sharedApplication;
        SpaceLauncher *delegate __attribute__((objc_precise_lifetime)) = [[SpaceLauncher alloc] init];
        app.delegate = delegate;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app run];
    }
    return 0;
}
