import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply } from '../index.js'

test('an unconfigured installation leaves the command available to an existing owner', async () => {
  const options = Config({})
  assert.deepEqual(options.projects, [])
  await apply({commands:{register(){ assert.fail('an unconfigured bundle registered a command') }}}, options)
})
