// 光标菜单/上下文菜单的视口夹取 —— 实现已上收到引擎(唯一真源,含 CSS zoom 反补偿 + 越界翻面):
// lcl/engine/menuAnchor.tsx。此处只留转发,免得 amadeus 侧的老 import 路径全都要改。
export { clampMenu, useClampedMenu, OverlayAt, zoomOf, UI_ZOOM_EVENT } from '@lcl/engine'
