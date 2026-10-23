/** 绕过 installEngine 的入口(台架页、测试)自己装 Tangu 的 store 半身;正式启动由 activateTangu 装(界面热更新 3c)。
 *  import 这个文件即装,重复 import / 之后再激活都不会重装(stores/appStore 的 installTanguSlice 只装一次)。 */
import { installTanguSlice } from '../../stores/appStore'
import { TANGU_SLICE } from './tanguSlice'

installTanguSlice(TANGU_SLICE)
