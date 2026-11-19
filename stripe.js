import Stripe from "stripe"
import { ObjectId } from "mongodb"

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const userFilter = (id) => {
  const clauses = [{ _id: id }, { id }]
  if (ObjectId.isValid(id)) clauses.push({ _id: new ObjectId(id) })
  return { $or: clauses }
}

export function createStripeWebhookHandler({ db, stripeClient = stripe }) {
  return async (request, response, next) => {
    const signingSecret = process.env.STRIPE_WEBHOOK_SECRET
    const signature = request.headers["stripe-signature"]
    if (!stripeClient || !signingSecret) {
      response.status(503).json({ error: "Stripe webhooks are not configured." })
      return
    }
    if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
      response.status(400).json({ error: "Invalid Stripe webhook request." })
      return
    }

    let event
    try {
      event = stripeClient.webhooks.constructEvent(
        request.body,
        signature,
        signingSecret,
      )
    } catch {
      response.status(400).json({ error: "Invalid Stripe webhook signature." })
      return
    }

    const webhookEvents = db.collection("webhookEvents")
    const priorEvent = await webhookEvents.findOne({ _id: event.id })
    if (priorEvent) {
      response.json({ received: true, duplicate: true })
      return
    }

    try {
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        const checkout = event.data.object
        if (checkout.mode === "subscription") {
          const users = db.collection("user")
          const transactions = db.collection("transactions")
          const vendorId = checkout.metadata?.vendorId ?? checkout.client_reference_id
          const subscriptionId =
            typeof checkout.subscription === "string"
              ? checkout.subscription
              : checkout.subscription?.id

          if (vendorId && subscriptionId) {
            const subscription = await stripeClient.subscriptions.retrieve(subscriptionId)
            const paid = ["paid", "no_payment_required"].includes(
              checkout.payment_status,
            )
            const active = ["active", "trialing"].includes(subscription.status)
            const vendor = await users.findOne(userFilter(vendorId))

            if (vendor?.role === "vendor" && paid && active) {
              const expiresAt = subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000)
                : null
              await users.updateOne(
                { _id: vendor._id },
                {
                  $set: {
                    subscriptionPlan: "premium",
                    subscriptionExpiresAt: expiresAt,
                    stripeSubscriptionId: subscription.id,
                    subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end,
                  },
                },
              )
              await transactions.updateOne(
                { stripeSessionId: checkout.id },
                {
                  $setOnInsert: {
                    vendorId,
                    plan: "premium",
                    amount: (checkout.amount_total ?? 0) / 100,
                    currency: checkout.currency ?? "usd",
                    stripeSessionId: checkout.id,
                    stripeSubscriptionId: subscription.id,
                    status: "succeeded",
                    createdAt: new Date(),
                  },
                },
                { upsert: true },
              )
            }
          }
        }
      } else if (
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      ) {
        const subscription = event.data.object
        const vendorId = subscription.metadata?.vendorId
        if (vendorId) {
          const users = db.collection("user")
          const vendor = await users.findOne(userFilter(vendorId))
          if (vendor?.role === "vendor") {
            const active =
              event.type !== "customer.subscription.deleted" &&
              ["active", "trialing"].includes(subscription.status)
            await users.updateOne(
              { _id: vendor._id },
              {
                $set: {
                  subscriptionPlan: active ? "premium" : "free",
                  subscriptionExpiresAt: active && subscription.current_period_end
                    ? new Date(subscription.current_period_end * 1000)
                    : null,
                  stripeSubscriptionId: active ? subscription.id : null,
                  subscriptionCancelAtPeriodEnd: active
                    ? subscription.cancel_at_period_end
                    : false,
                },
              },
            )
          }
        }
      } else if (event.type === "checkout.session.async_payment_failed") {
        const checkout = event.data.object
        const transactions = db.collection("transactions")
        await transactions.updateOne(
          { stripeSessionId: checkout.id },
          { $set: { status: "failed" } },
        )
      }

      await webhookEvents.insertOne({
        _id: event.id,
        type: event.type,
        processedAt: new Date(),
      })
      response.json({ received: true })
    } catch (error) {
      if (error?.code === 11000) {
        response.json({ received: true, duplicate: true })
        return
      }
      next(error)
    }
  }
}
