import test from "node:test"
import assert from "node:assert/strict"
import { meetsPasswordPolicy } from "./password-policy.js"

test("requires at least six characters and both letter cases", () => {
  assert.equal(meetsPasswordPolicy("Abc12"), false)
  assert.equal(meetsPasswordPolicy("Abcdef"), true)
  assert.equal(meetsPasswordPolicy("abcdef"), false)
  assert.equal(meetsPasswordPolicy("ABCDEF"), false)
  assert.equal(meetsPasswordPolicy(null), false)
})
