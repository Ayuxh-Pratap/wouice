import { useState } from 'react'
export function ImagePreview({ path, src }: { path: string; src: string }): React.JSX.Element {
  const [size, setSize] = useState(''), [failed, setFailed] = useState(false), [zoom, setZoom] = useState(1)
  return <section className="project-image-preview" aria-label="Image preview">
    <div className="project-image-tools"><span>Read-only image · {size}</span><button onClick={() => setZoom(n => n === 4 ? 1 : n * 2)}>{zoom * 100}%</button></div>
    {failed ? <p role="alert">This image could not be decoded. The file has not been changed.</p> : <div className="project-image-canvas"><img src={src} alt={path} style={{ transform: `scale(${zoom})` }} onLoad={e => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} onError={() => setFailed(true)} /></div>}
  </section>
}
