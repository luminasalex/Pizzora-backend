import "dotenv/config"
import cors from "cors"
import express from "express"
import { fromNodeHeaders, toNodeHandler } from "better-auth/node"
import { auth, db, mongoClient } from "./auth.js"

const app = express()
const port = Number(process.env.PORT || 3001)
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

app.disable("x-powered-by")
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
)

app.all("/api/auth/{*path}", toNodeHandler(auth))
app.use(express.json({ limit: "1mb" }))

app.get("/", (_request, response) => {
  response.json({ name: "Pizzora API", status: "ok" })
})

app.get("/health", (_request, response) => {
  response.json({ status: "ok" })
})

app.get("/api/users/me", async (request, response, next) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    })

    if (!session) {
      response.status(401).json({ error: "Authentication required." })
      return
    }

    if (session.user.isBlocked) {
      response.status(403).json({ error: "This account is blocked." })
      return
    }

    response.json({ user: session.user })
  } catch (error) {
    next(error)
  }
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ error: "An unexpected server error occurred." })
})

const server = async () => {
  await mongoClient.connect()
  await db.collection("menuItems").createIndex({ vendorId: 1 })
  await db.collection("menuItems").createIndex({ status: 1, availability: 1 })
  await db.collection("menuItems").createIndex({ category: 1 })
  await db.collection("menuItems").createIndex({ location: 1 })
  await db.collection("menuItems").createIndex({ price: 1 })

  app.listen(port, () => {
    console.log(`Pizzora API is listening on port ${port}.`)
  })
}

server().catch(async (error) => {
  console.error("Failed to start Pizzora API.", error)
  await mongoClient.close()
  process.exitCode = 1
})

process.on("SIGINT", async () => {
  await mongoClient.close()
  process.exit(0)
})

process.on("SIGTERM", async () => {
  await mongoClient.close()
  process.exit(0)
})
