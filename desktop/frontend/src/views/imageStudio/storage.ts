import { isImageBoard, type ImageBoard } from './model'

let database: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('forsion-image-studio', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('boards', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
    request.onblocked = () => { database = undefined; reject(new Error('Image Studio storage is blocked by another window')) }
  })
}
export async function loadBoards(): Promise<ImageBoard[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = db.transaction('boards').objectStore('boards').getAll()
    request.onsuccess = () => {
      if (!request.result.every(isImageBoard)) { reject(new Error('Image Studio contains an unreadable project')); return }
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
  })
}
export async function saveBoard(board: ImageBoard): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('boards', 'readwrite')
    tx.objectStore('boards').put(board)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('Image Studio save was interrupted'))
  })
}
