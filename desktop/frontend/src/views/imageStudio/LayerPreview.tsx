import { imageFilter, imageSize, isImage, type StudioImage, type StudioItem } from './model'
import { elementMarkup } from './scene'
import { useBlobUrl } from './useImages'

export function ImageThumbnail({ image, className }: { image: StudioImage; className?: string }) {
  const src = useBlobUrl(image.blob), size = imageSize(image)
  const c = image.crop || { x: 0, y: 0, w: image.width, h: image.height }
  return <svg className={`ims-raster ${className || ''}`} role="img" aria-label={image.name} data-original-width={image.width}
    viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="xMidYMid meet" style={{ filter: imageFilter(image) }}>
    <g transform={`translate(${size.w / 2} ${size.h / 2}) rotate(${image.rotation || 0}) scale(${image.flipX ? -1 : 1} ${image.flipY ? -1 : 1})`}>
      <svg x={-c.w / 2} y={-c.h / 2} width={c.w} height={c.h} viewBox={`${c.x} ${c.y} ${c.w} ${c.h}`} overflow="hidden">
        {src && <image href={src} width={image.width} height={image.height} />}
      </svg>
    </g>
  </svg>
}
export function LayerPreview({ item }: { item: StudioItem }) {
  return isImage(item) ? <ImageThumbnail image={item} /> : <svg role="img" aria-label={item.name} viewBox={`0 0 ${item.w} ${item.h}`} preserveAspectRatio="xMidYMid meet" overflow="hidden" dangerouslySetInnerHTML={{ __html: elementMarkup(item) }} />
}
