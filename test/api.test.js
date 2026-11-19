import assert from "node:assert/strict"
import { once } from "node:events"
import express from "express"
import test from "node:test"
import { ObjectId } from "mongodb"
import { createApiRouter } from "../api.js"

const startApi = async (session, collections = {}) => {
  const app = express()
  const user = session?.user ?? null
  const tokenUserCollection = {
    findOne: async () => user,
  }
  const auth = {
    api: {
      verifyJWT: async ({ body }) =>
        ["test-token", "forged-admin-token"].includes(body.token) && user
          ? {
              payload: {
                sub: user.id,
                ...(body.token === "forged-admin-token" ? { role: "admin" } : {}),
              },
            }
          : { payload: null },
    },
  }
  const db = {
    collection: (name) =>
      collections[name] ?? (name === "user" ? tokenUserCollection : {}),
  }
  app.use("/api", createApiRouter({ db, auth }))
  const server = app.listen(0)
  await once(server, "listening")

  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  }
}

test("categories endpoint returns the supported menu categories", async (t) => {
  const api = await startApi(null)
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/categories`)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.length, 6)
})

test("protected endpoints reject unauthenticated requests", async (t) => {
  const api = await startApi(null)
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/dashboard/customer`)
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.error, "Authentication required.")
})

test("a Better Auth session cookie alone does not authenticate protected APIs", async (t) => {
  const api = await startApi({ user: { id: "customer-1", role: "customer" } })
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/dashboard/customer`, {
    headers: { cookie: "better-auth.session_token=session" },
  })

  assert.equal(response.status, 401)
})

test("invalid bearer tokens are rejected", async (t) => {
  const api = await startApi({ user: { id: "customer-1", role: "customer" } })
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/dashboard/customer`, {
    headers: { authorization: "Bearer invalid-token" },
  })
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.error, "Invalid or expired authentication token.")
})

test("blocked accounts cannot access protected endpoints", async (t) => {
  const api = await startApi({ user: { id: "customer-1", role: "customer", isBlocked: true } })
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/dashboard/customer`, {
    headers: { authorization: "Bearer test-token" },
  })
  const body = await response.json()

  assert.equal(response.status, 403)
  assert.equal(body.error, "This account is blocked.")
})

test("authenticated users without the required role are rejected", async (t) => {
  const api = await startApi({ user: { id: "vendor-1", role: "vendor", isBlocked: false } })
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/dashboard/customer`, {
    headers: { authorization: "Bearer test-token" },
  })
  const body = await response.json()

  assert.equal(response.status, 403)
  assert.equal(body.error, "You do not have permission to perform this action.")
})

test("authorization uses the database role rather than JWT role claims", async (t) => {
  const api = await startApi({
    user: { id: "vendor-1", role: "vendor", isBlocked: false },
  })
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/dashboard/admin`, {
    headers: { authorization: "Bearer forged-admin-token" },
  })

  assert.equal(response.status, 403)
})

test("public menu search returns approved items and eligible vendor details", async (t) => {
  const itemId = new ObjectId()
  let menuFilter
  const vendor = {
    id: "vendor-1",
    name: "Restaurant Owner",
    businessName: "Pizzora Kitchen",
    role: "vendor",
  }
  const item = {
    _id: itemId,
    itemName: "Pepperoni Pizza",
    category: "Classic Pizzas",
    vendorId: vendor.id,
    status: "approved",
    availability: true,
    price: 12.5,
    images: ["https://images.example/pizza.jpg"],
  }
  const cursor = (records) => ({
    project() { return this },
    sort() { return this },
    skip() { return this },
    limit() { return this },
    async toArray() { return records },
  })
  const collections = {
    user: {
      find: () => cursor([vendor]),
    },
    menuItems: {
      find: (filter) => {
        menuFilter = filter
        return cursor([item])
      },
      countDocuments: async () => 1,
    },
  }
  const api = await startApi(null, collections)
  t.after(() => api.server.close())

  const response = await fetch(
    `${api.url}/api/menu-items?search=pepperoni&category=Classic%20Pizzas&sort=price_asc`,
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data[0].itemName, item.itemName)
  assert.equal(body.data[0].vendor.name, vendor.businessName)
  assert.equal(menuFilter.status, "approved")
  assert.equal(menuFilter.availability, true)
  assert.ok(menuFilter.itemName.test(item.itemName))
  assert.equal(menuFilter.category, "Classic Pizzas")
})

test("vendor subscription status comes from the authenticated account", async (t) => {
  const api = await startApi({
    user: {
      id: "vendor-1",
      role: "vendor",
      isBlocked: false,
      subscriptionPlan: "premium",
      subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
    },
  })
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/subscriptions/current`, {
    headers: { authorization: "Bearer test-token" },
  })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.plan, "premium")
  assert.equal(body.data.expiresAt, "2030-01-01T00:00:00.000Z")
})

test("premium checkout is unavailable without Stripe configuration", async (t) => {
  const api = await startApi({
    user: { id: "vendor-1", role: "vendor", isBlocked: false, subscriptionPlan: "free" },
  })
  t.after(() => api.server.close())

  const response = await fetch(`${api.url}/api/subscriptions/checkout`, {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
  })
  const body = await response.json()

  assert.equal(response.status, 503)
  assert.equal(body.error, "Premium checkout is not configured.")
})
