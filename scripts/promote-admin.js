import "dotenv/config"
import { MongoClient } from "mongodb"

const email = process.argv[2]?.trim().toLowerCase()

if (!email) {
  throw new Error("Usage: npm run promote-admin -- user@example.com")
}

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required.")
}

const client = new MongoClient(process.env.MONGODB_URI)

try {
  await client.connect()
  const db = client.db(process.env.DB_NAME || "Pizzora")
  const result = await db.collection("user").updateOne(
    { email },
    { $set: { role: "admin" } },
  )

  if (result.matchedCount !== 1) {
    throw new Error(`No existing account found for ${email}.`)
  }

  console.log(`Granted admin role to ${email}.`)
} finally {
  await client.close()
}
