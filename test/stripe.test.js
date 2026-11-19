import assert from "node:assert/strict"
import { once } from "node:events"
import express from "express"
import test from "node:test"
import { createStripeWebhookHandler } from "../stripe.js"

const startWebhook = async (
  event,
  storedEvents = new Map(),
  extraCollections = {},
  stripeOverrides = {},
) => {
  process.env.STRIPE_WEBHOOK_SECRET = "test-webhook-secret"
  const stripeClient = {
    webhooks: {
      constructEvent: (body, signature, secret) => {
        assert.ok(Buffer.isBuffer(body))
        assert.equal(signature, "test-signature")
        assert.equal(secret, "test-webhook-secret")
        return event
      },
    },
    ...stripeOverrides,
  }
  const eventCollection = {
    findOne: async ({ _id }) => storedEvents.get(_id) ?? null,
    insertOne: async (document) => {
      storedEvents.set(document._id, document)
    },
  }
  const db = {
    collection: (name) => {
      if (name === "webhookEvents") return eventCollection
      if (extraCollections[name]) return extraCollections[name]
      throw new Error(`Unexpected collection access: ${name}`)
    },
  }
  const app = express()
  app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    createStripeWebhookHandler({ db, stripeClient }),
  )
  const server = app.listen(0)
  await once(server, "listening")

  return {
    server,
    storedEvents,
    url: `http://127.0.0.1:${server.address().port}/webhook`,
  }
}

test("Stripe webhook verifies raw request bodies and records processed event IDs", async (t) => {
  const event = { id: "evt_test_1", type: "ignored.event", data: { object: {} } }
  const webhook = await startWebhook(event)
  t.after(() => webhook.server.close())

  const response = await fetch(webhook.url, {
    method: "POST",
    headers: { "stripe-signature": "test-signature", "content-type": "application/json" },
    body: JSON.stringify({ event: true }),
  })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.received, true)
  assert.equal(webhook.storedEvents.has(event.id), true)
})

test("Stripe webhook acknowledges an already processed event without processing it again", async (t) => {
  const event = { id: "evt_test_duplicate", type: "ignored.event", data: { object: {} } }
  const storedEvents = new Map([[event.id, { _id: event.id }]])
  const webhook = await startWebhook(event, storedEvents)
  t.after(() => webhook.server.close())

  const response = await fetch(webhook.url, {
    method: "POST",
    headers: { "stripe-signature": "test-signature", "content-type": "application/json" },
    body: JSON.stringify({ event: true }),
  })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.duplicate, true)
  assert.equal(storedEvents.size, 1)
})

test("only a paid, verified subscription checkout activates Premium", async (t) => {
  const event = {
    id: "evt_paid_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        mode: "subscription",
        payment_status: "paid",
        metadata: { vendorId: "vendor-1" },
        subscription: "sub_test_1",
        currency: "usd",
        amount_total: 2900,
      },
    },
  }
  const userUpdates = []
  const transactionUpdates = []
  const extraCollections = {
    user: {
      findOne: async () => ({ _id: "vendor-doc", role: "vendor" }),
      updateOne: async (_filter, update) => userUpdates.push(update),
    },
    transactions: {
      updateOne: async (_filter, update) => transactionUpdates.push(update),
    },
  }
  const webhook = await startWebhook(
    event,
    new Map(),
    extraCollections,
    {
      subscriptions: {
        retrieve: async () => ({
          id: "sub_test_1",
          status: "active",
          current_period_end: 1_900_000_000,
        }),
      },
    },
  )
  t.after(() => webhook.server.close())

  const response = await fetch(webhook.url, {
    method: "POST",
    headers: { "stripe-signature": "test-signature", "content-type": "application/json" },
    body: JSON.stringify({ event: true }),
  })

  assert.equal(response.status, 200)
  assert.equal(userUpdates[0].$set.subscriptionPlan, "premium")
  assert.equal(transactionUpdates[0].$setOnInsert.status, "succeeded")
})

test("an unpaid Stripe checkout does not activate Premium", async (t) => {
  const event = {
    id: "evt_unpaid_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_unpaid",
        mode: "subscription",
        payment_status: "unpaid",
        metadata: { vendorId: "vendor-1" },
        subscription: "sub_test_unpaid",
      },
    },
  }
  let userUpdates = 0
  const webhook = await startWebhook(
    event,
    new Map(),
    {
      user: {
        findOne: async () => ({ _id: "vendor-doc", role: "vendor" }),
        updateOne: async () => { userUpdates += 1 },
      },
      transactions: { updateOne: async () => {} },
    },
    {
      subscriptions: {
        retrieve: async () => ({
          id: "sub_test_unpaid",
          status: "active",
          current_period_end: 1_900_000_000,
        }),
      },
    },
  )
  t.after(() => webhook.server.close())

  const response = await fetch(webhook.url, {
    method: "POST",
    headers: { "stripe-signature": "test-signature", "content-type": "application/json" },
    body: JSON.stringify({ event: true }),
  })

  assert.equal(response.status, 200)
  assert.equal(userUpdates, 0)
})
