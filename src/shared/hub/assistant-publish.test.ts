import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvedInstall } from '../plugins/assistant-install.ts'
import { notPublished, PUBLISH, publishQuestion } from './assistant-publish.ts'

test('the user is asked with the name and version Hub will read, and where it is listed, before anything is sent', () => {
  const question = publishQuestion({ name: 'brief', version: '1.0.0', handle: 'acme' })
  assert.equal(
    question.text,
    'Publish the skill brief 1.0.0 to Jaspers Hub? It is sent as acme/brief and waits there for review; nothing is sent until you say Publish. By publishing, you agree to the Terms of Use (https://jsprai.com/terms), including its publisher representations: you have the right to publish this, it contains no malicious code, it infringes no one’s rights, and its data sources are used within their terms.',
  )
  assert.equal(
    question.code,
    ['skill    brief', 'version  1.0.0', 'page     https://hub.jsprai.com/acme/brief'].join('\n'),
  )
  const plugin = publishQuestion({ kind: 'plugin', name: 'demo', version: '1.0.1', handle: 'acme' })
  assert.equal(
    plugin.text,
    'Publish the plugin demo 1.0.1 to Jaspers Hub? It is sent as acme/demo and waits there for review; nothing is sent until you say Publish. By publishing, you agree to the Terms of Use (https://jsprai.com/terms), including its publisher representations: you have the right to publish this, it contains no malicious code, it infringes no one’s rights, and its data sources are used within their terms.',
  )
  assert.equal(plugin.code, ['plugin   demo', 'version  1.0.1', 'page     https://hub.jsprai.com/acme/demo'].join('\n'))
})

test("only Publish sends: Cancel, a closed question, and words of the user's own send nothing, and the model is told to leave it", () => {
  assert.equal(PUBLISH, 'Publish')
  assert.equal(approvedInstall(PUBLISH, PUBLISH), true)
  for (const answer of ['Cancel', null, 'yes', 'publish']) assert.equal(approvedInstall(answer, PUBLISH), false)
  assert.equal(
    notPublished('brief'),
    'The user did not approve publishing the skill brief, so nothing was sent. Leave it; do not ask again in other words.',
  )
  assert.equal(
    notPublished('demo', 'plugin'),
    'The user did not approve publishing the plugin demo, so nothing was sent. Leave it; do not ask again in other words.',
  )
})
