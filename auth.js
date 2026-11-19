import { MongoClient } from "mongodb"
import { mongodbAdapter } from "@better-auth/mongo-adapter"
import { betterAuth } from "better-auth"
import "dotenv/config"

const mongoUri = process.env.MONGODB_URI
const authSecret = process.env.BETTER_AUTH_SECRET

if (!mongoUri) {
  throw new Error("MONGODB_URI is required to start the authentication service.")
}

if (!authSecret || authSecret.length < 32) {
  throw new Error("BETTER_AUTH_SECRET must be at least 32 characters long.")
}

export const mongoClient = new MongoClient(mongoUri)
export const db = mongoClient.db(process.env.DB_NAME || "Pizzora")

const allowedSignupRoles = new Set(["customer", "vendor"])

export const auth = betterAuth({
  appName: "Pizzora",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3001",
  secret: authSecret,
  trustedOrigins: (process.env.CLIENT_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  advanced: {
    defaultCookieAttributes: {
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  socialProviders:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : undefined,
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "customer",
        input: true,
      },
      businessName: {
        type: "string",
        required: false,
        input: true,
      },
      isBlocked: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      subscriptionPlan: {
        type: "string",
        required: false,
        defaultValue: "free",
        input: false,
      },
      subscriptionExpiresAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({
          data: {
            ...user,
            role: allowedSignupRoles.has(user.role) ? user.role : "customer",
            businessName:
              user.role === "vendor" &&
              typeof user.businessName === "string" &&
              user.businessName.trim().length <= 120
                ? user.businessName.trim()
                : undefined,
            isBlocked: false,
            subscriptionPlan: "free",
          },
        }),
      },
    },
  },
  database: mongodbAdapter(db, { client: mongoClient }),
})
