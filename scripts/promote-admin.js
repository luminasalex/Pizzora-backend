import "dotenv/config"
import { MongoClient } from "mongodb"

const email = process.argv[2]?.trim().toLowerCase()
if (!email || process.argv.length !== 3) {
  console.error("Usage: npm run promote-admin -- user@example.com")
  process.exitCode = 1
} else if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required.")
} else {
  const client = new MongoClient(process.env.MONGODB_URI)
  try {
    await client.connect()
    const db = client.db(process.env.DB_NAME || "Pizzora")
    const users = db.collection("user")
    const user = await users.findOne({ email })
    if (!user) {
      throw new Error(`No existing account was found for ${email}.`)
    }

    if (user.role !== "admin") {
      await users.updateOne(
        { _id: user._id },
        { $set: { role: "admin", updatedAt: new Date() } },
      )
    }
    console.log(`Admin role is active for ${email}.`)
  } finally {
    await client.close()
  }
}
