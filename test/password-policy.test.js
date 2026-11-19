import assert from "node:assert/strict"
import test from "node:test"
import { meetsPasswordPolicy } from "../password-policy.js"

test("signup password policy requires uppercase and lowercase letters", () => {
  assert.equal(meetsPasswordPolicy("lowercase1"), false)
  assert.equal(meetsPasswordPolicy("UPPERCASE1"), false)
  assert.equal(meetsPasswordPolicy("MixedCase1"), true)
  assert.equal(meetsPasswordPolicy(undefined), false)
})
