export function FileIcon({ path, directory = false, expanded = false }: { path: string; directory?: boolean; expanded?: boolean }): React.JSX.Element {
  if (directory) return <svg className="project-file-icon folder" aria-hidden="true" viewBox="0 0 20 20"><path d={expanded ? 'M2 6V4h6l2 2h7v2M2 8h17l-3 8H3Z' : 'M2 4h6l2 2h8v10H2Z'} /></svg>
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '', ext = name.split('.').pop() ?? ''
  const kind = ['ts', 'tsx'].includes(ext) ? 'ts' : ['js', 'jsx', 'mjs', 'cjs'].includes(ext) ? 'js' : ['css', 'scss'].includes(ext) ? 'css' : ['png', 'jpg', 'jpeg', 'svg', 'webp', 'ico'].includes(ext) ? 'image' : ['md', 'txt'].includes(ext) ? 'text' : ext === 'json' ? 'json' : name.startsWith('.') ? 'config' : 'file'
  const color = { ts: '#3178c6', js: '#f0db4f', css: '#9565d6', image: '#ba6aa4', text: '#559fb5', json: '#a0b45d', config: '#85917b', file: '#8793a2' }[kind]
  const label = { ts: 'TS', js: 'JS', css: '#', image: '', text: 'M↓', json: '{}', config: '·', file: '‹›' }[kind]
  return <svg aria-hidden="true" className={`project-file-icon ${kind}`} viewBox="0 0 24 24">
    <rect x="2" y="2" width="20" height="20" rx="3" fill={color} />
    {kind === 'image' ? <><circle cx="8" cy="8" r="2" fill="white" /><path d="m4 19 6-7 4 4 3-4 4 7Z" fill="white" /></> : <text x="12" y="16" textAnchor="middle" fontSize={kind === 'text' ? '9' : '11'} fontWeight="700" fontFamily="Arial,sans-serif" fill={kind === 'js' || kind === 'json' ? '#152014' : 'white'}>{label}</text>}
    {['tsx', 'jsx'].includes(ext) && <circle cx="20" cy="4" r="3" fill="#65dcf5" stroke="#122029" />}
  </svg>
}
