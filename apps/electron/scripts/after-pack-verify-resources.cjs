#!/usr/bin/env node
/**
 * electron-builder afterPack 资源门禁：验证产物中的 extraResources，不验证源码目录。
 * 失败直接抛错，禁止把资源缺失/漂移的包宣布为可部署。
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function fail(message) { throw new Error(`[afterPack] 工程模板资源校验失败：${message}`) }

module.exports = async function afterPack(context) {
  const root = path.join(context.appOutDir, 'resources', 'nanju-engineering-templates')
  const manifestPath = path.join(root, 'manifest.json')
  if (!fs.existsSync(manifestPath)) fail(`manifest.json 不存在：${root}`)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch (error) { fail(`manifest.json 不可解析：${error.message}`) }
  const entries = [...(manifest.templates || []), ...(manifest.sharedFiles || [])]
  if (entries.length === 0) fail('manifest 没有资源条目')
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || entry.path.includes('..') || path.isAbsolute(entry.path)) fail(`非法资源路径：${entry.path}`)
    const file = path.join(root, entry.path)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`资源缺失：${entry.path}`)
    const size = fs.statSync(file).size
    const digest = sha256(file)
    if (size !== entry.size || digest !== entry.sha256) fail(`资源哈希/大小不一致：${entry.path}`)
  }
  const required = entries.filter(entry => entry.required).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const bundle = crypto.createHash('sha256')
    .update(required.map(entry => `${entry.path}\0${entry.sha256}`).join('\n'))
    .digest('hex')
  if (bundle !== manifest.bundleSha256) fail(`bundleSha256 不一致：${bundle} != ${manifest.bundleSha256}`)
  const unexpected = fs.readdirSync(root).filter(name => /\.bak$|\.tmp$|\.corrupt-/.test(name))
  if (unexpected.length) fail(`产物含临时/备份资源：${unexpected.join(', ')}`)
  console.log(`[afterPack] 工程模板资源校验通过：${root} (${required.length} required)`)
}
