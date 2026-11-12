/** Curated Unsplash CDN URLs: no random/redirect endpoint or API key required. */
const PHOTOS = [
  ['1470770841072-f978cf4d019e', 'lake mountains landscape 湖泊 山脉 风景'],
  ['1441974231531-c6227db76b6e', 'forest trees nature 森林 树木 自然'],
  ['1518837695005-2083093ee35b', 'ocean sea waves 海洋 大海 海浪'],
  ['1464822759023-fed622ff2c3b', 'mountains alpine snow 山脉 雪山'],
  ['1449824913935-59a10b8d2000', 'city architecture street 城市 建筑 街道'],
  ['1419242902214-272b3f66ee7a', 'night stars sky space 夜晚 星空 宇宙'],
  ['1476514525535-07fb3b4ae5f1', 'lake mountains nature 湖泊 山脉 自然'],
  ['1500534623283-312aade485b7', 'landscape hills green 风景 山丘 绿色'],
  ['1469474968028-56623f02e42e', 'nature mountains landscape 自然 山脉 风景'],
  ['1509316785289-025f5b846b35', 'desert dunes sand 沙漠 沙丘'],
  ['1501785888041-af3ef285b470', 'lake water reflection 湖泊 水 倒影'],
  ['1490750967868-88aa4486c946', 'flowers blossom spring 花朵 樱花 春天'],
] as const

export const UNSPLASH_COVERS = PHOTOS.map(([id, keywords]) => ({
  thumb: `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=320&h=180&q=75`,
  full: `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1600&h=900&q=85`,
  keywords,
}))

export function searchFeaturedCovers(query: string): typeof UNSPLASH_COVERS {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return UNSPLASH_COVERS.filter((photo) => words.every((word) => photo.keywords.includes(word)))
}
