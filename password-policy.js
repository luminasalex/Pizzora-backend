export const meetsPasswordPolicy = (password) =>
  typeof password === "string" && /[A-Z]/.test(password) && /[a-z]/.test(password)
