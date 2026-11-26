/** 插件桌面小窗的护栏纯函数(shared/desktopWindow.ts):尺寸不超过工作区一半、至少 32 px 留在屏幕里、请求形状不对就拒。
 *  负对照(11-26 已实跑红):clampDesktopSize 去掉「/ 2」→「不超过工作区宽、高各一半」红;位置夹取改成整窗都在屏内 →
 *  「能从屏幕边探头」红;screenOf 只取第一块屏 →「挪到副屏上不被拽回主屏」红;只夹一次(11-26 评审)→「夹到不动为止」红。 */
import { describe, expect, it } from 'vitest'
import { clampDesktopBounds, clampDesktopSize, defaultDesktopBounds, normalizePrepareRequest, screenOf, type DesktopScreen } from './desktopWindow'

const main: DesktopScreen = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 800 }, scaleFactor: 2 }
const side: DesktopScreen = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }

describe('clampDesktopSize', () => {
  it('不超过工作区宽、高各一半,不小于 16', () => {
    expect(clampDesktopSize({ width: 5000, height: 5000 }, main.workArea)).toEqual({ width: 720, height: 400 })
    expect(clampDesktopSize({ width: 2, height: -10 }, main.workArea)).toEqual({ width: 16, height: 16 })
    expect(clampDesktopSize({ width: 'x', height: NaN }, main.workArea)).toEqual({ width: 160, height: 160 })
  })
})

describe('clampDesktopBounds', () => {
  it('能从屏幕边探头:超出去的部分留着,但两个方向都至少 32 px 在屏里', () => {
    expect(clampDesktopBounds({ x: -150, y: 880, width: 160, height: 160 }, [main])).toEqual({ x: -128, y: 868, width: 160, height: 160 })
    expect(clampDesktopBounds({ x: 1430, y: -500, width: 160, height: 160 }, [main])).toEqual({ x: 1408, y: -128, width: 160, height: 160 })
  })
  it('按屏幕整块算:可以站在 Dock / 任务栏上(工作区外、屏幕内)', () => {
    expect(clampDesktopBounds({ x: 100, y: 840, width: 160, height: 60 }, [main])).toEqual({ x: 100, y: 840, width: 160, height: 60 })
  })
  it('挪到副屏上不被拽回主屏;尺寸按所在屏的工作区夹', () => {
    expect(clampDesktopBounds({ x: 2000, y: 300, width: 1500, height: 900 }, [main, side])).toEqual({ x: 2000, y: 300, width: 960, height: 520 })
  })
  it('两块屏都不沾:落回中心最近的那块', () => {
    expect(screenOf({ x: 9000, y: 50, width: 10, height: 10 }, [main, side])?.id).toBe(2)
    expect(clampDesktopBounds({ x: 9000, y: 50, width: 160, height: 160 }, [main, side]).x).toBe(1440 + 1920 - 32)
  })
  it('没有屏幕表:原样(只取整)', () => {
    expect(clampDesktopBounds({ x: 1.4, y: 2.6, width: 100, height: 100 }, [])).toEqual({ x: 1, y: 3, width: 100, height: 100 })
  })
})

describe('defaultDesktopBounds / normalizePrepareRequest', () => {
  it('缺省放工作区右下角,离边 24', () => {
    expect(defaultDesktopBounds({ width: 160, height: 160 }, main.workArea)).toEqual({ x: 1256, y: 641, width: 160, height: 160 })
  })
  it('请求形状不对就拒;字段去空白、限长,pin 缺省 true', () => {
    expect(normalizePrepareRequest(null)).toBeNull()
    expect(normalizePrepareRequest({ pluginId: '  ' })).toBeNull()
    expect(normalizePrepareRequest({ pluginId: 'x'.repeat(129) })).toBeNull()
    expect(normalizePrepareRequest({ pluginId: ' pet ', key: ' a ', title: 7 })).toEqual({ pluginId: 'pet', pluginName: 'pet', key: 'a', title: '', width: 160, height: 160, pin: true })
    expect(normalizePrepareRequest({ pluginId: 'pet', pin: false })?.pin).toBe(false)
  })
})

describe('clampDesktopBounds 夹到不动为止(11-26 评审)', () => {
  it('左边一块窄屏、右边一块宽屏:缩小后换成压在左屏上更多,再按左屏夹;再夹一次结果不变', () => {
    const left: DesktopScreen = { id: 3, bounds: { x: -800, y: 0, width: 800, height: 900 }, workArea: { x: -800, y: 0, width: 800, height: 900 }, scaleFactor: 1 }
    const right: DesktopScreen = { id: 4, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
    const once = clampDesktopBounds({ x: -600, y: 100, width: 1500, height: 200 }, [left, right])
    expect(once).toEqual({ x: -600, y: 100, width: 400, height: 200 })
    expect(clampDesktopBounds(once, [left, right])).toEqual(once)
  })
})
