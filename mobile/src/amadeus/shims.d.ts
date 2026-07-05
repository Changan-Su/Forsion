// path-browserify 无自带类型;它是 node path 的 POSIX 子集(resolve/relative/join/dirname/basename/extname/isAbsolute)。
// 声明为 any:运行时方法齐全,类型精度在此不重要(esbuild 构建不做类型检查)。
declare module 'path-browserify' {
  const path: any
  export default path
}
