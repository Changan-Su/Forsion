export interface LibraryDeviceSources {
  devices?: readonly { deviceId: string; name: string }[]
  markerDevices?: readonly { id: string; name: string; superseded?: boolean }[] | null
}

export function libraryDeviceNames({ devices, markerDevices }: LibraryDeviceSources): string[] {
  const names = new Map(devices?.map((device) => [device.deviceId, device.name]))
  for (const device of markerDevices ?? []) {
    if (!device.superseded && !names.has(device.id)) names.set(device.id, device.name)
  }
  return [...names.values()]
}
