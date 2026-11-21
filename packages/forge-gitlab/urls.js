// URL mappings adapted from futuretea/dsh-forge-gitlab v0.1.1 (MIT).
const segment = /^[a-z0-9_][a-z0-9_.-]*$/i
export const positive = n => Number.isSafeInteger(n) && n > 0
export const sha = s => typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s)
export const filePath = p => typeof p === 'string' && !/[\x00-\x1f\x7f\\]/.test(p) && p.split('/').every(s => s && s !== '.' && s !== '..')
export function validRepo(repo, hosts) {
  return repo?.forge === 'gitlab' && hosts.has(repo.host) && typeof repo.owner === 'string' && repo.owner.split('/').every(s => segment.test(s)) && typeof repo.name === 'string' && segment.test(repo.name)
}
export const validRef = (ref, hosts) => validRepo(ref?.repository, hosts) && positive(ref.number)
export const projectPath = ({owner,name}) => `projects/${encodeURIComponent(`${owner}/${name}`)}`
export const mrPath = ref => `${projectPath(ref.repository)}/merge_requests/${ref.number}`
export const mrUrl = ({repository: {host, owner, name}, number}) => `https://${host}/${owner}/${name}/-/merge_requests/${number}`
function repoOf(host, path, hosts) {
  const parts = path.split('/')
  const repo = {forge: 'gitlab', host: host.toLowerCase(), name: parts.pop(), owner: parts.join('/')}
  return validRepo(repo, hosts) ? repo : undefined
}
export function repositoryFromRemote(url, hosts) {
  if (typeof url !== 'string' || /[\x00-\x20\x7f\\?#%]/.test(url)) return
  const web = /^https?:\/\/([^/@]+)\/(.+)$/.exec(url)
  const ssh = /^(?:ssh|git):\/\/(?:[\w.-]+@)?([a-z\d.-]+)(?::\d+)?\/(.+)$/i.exec(url)
  const scp = /^[\w.-]+@([a-z\d.-]+):(.+)$/i.exec(url)
  const m = web || ssh || scp
  if (m) return repoOf(m[1], m[2].replace(/\/+$/, '').replace(/\.git$/, ''), hosts)
}
export function changeRequestFromUrl(url, hosts) {
  if (typeof url !== 'string' || /[\x00-\x20\x7f\\]/.test(url)) return
  const m = /^https?:\/\/([^/@?#]+)\/([^?#]+?)\/(?:-\/)?merge_requests\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/.exec(url)
  if (!m) return
  const repository = repoOf(m[1], m[2], hosts)
  const number = Number(m[3])
  if (repository && positive(number)) return {repository, number}
}
