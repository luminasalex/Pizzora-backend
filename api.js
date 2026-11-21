import express from "express"
import { ObjectId } from "mongodb"

const categories = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
]

const categoryAliases = {
  "Specialty & Gourmet Pizzas": "Specialty / Gourmet Pizzas",
  "Specialty & Gourmet": "Specialty / Gourmet Pizzas",
  "Specialty / Gourmet": "Specialty / Gourmet Pizzas",
  "Drinks & Desserts": "Beverages & Desserts",
  "Sides & More": "Sides & Appetizers",
}

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const isHttpsUrl = (value) => {
  if (typeof value !== "string") return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}
const idFilter = (id) => {
  const clauses = [{ _id: id }, { id }]
  if (ObjectId.isValid(id)) clauses.push({ _id: new ObjectId(id) })
  return { $or: clauses }
}
const documentId = (document) => String(document.id ?? document._id)
const vendorIdVariants = (vendor) => {
  const variants = [vendor.id, String(vendor._id), vendor._id]
  if (vendor.id && ObjectId.isValid(vendor.id)) {
    variants.push(new ObjectId(vendor.id))
  }
  return [...new Set(variants.filter((value) => value !== undefined && value !== null))]
}
const categoryVariants = (category) => {
  const normalized = categoryAliases[category] ?? category
  return [...new Set([category, normalized])]
}
const parsePagination = (query) => {
  const page = Number.parseInt(query.page ?? "1", 10)
  const limit = Number.parseInt(query.limit ?? "12", 10)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new ApiError(400, "Invalid page or limit.")
  }
  return { page, limit: Math.min(limit, 50) }
}
const safeMenuItem = (item) => ({
  ...item,
  id: String(item._id),
  _id: undefined,
})

export function createApiRouter({ db, auth, stripe }) {
  const router = express.Router()
  const users = db.collection("user")
  const menuItems = db.collection("menuItems")
  const orders = db.collection("orders")
  const transactions = db.collection("transactions")
  const uploadWindows = new Map()

  const authenticate = async (request, _response, next) => {
    try {
      const authorization = request.get("authorization") ?? ""
      const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
      if (!match) throw new ApiError(401, "Authentication required.")

      const verification = await auth.api.verifyJWT({
        body: { token: match[1] },
      })
      const subject = verification?.payload?.sub
      if (typeof subject !== "string" || !subject) {
        throw new ApiError(401, "Invalid or expired authentication token.")
      }

      const user = await users.findOne(idFilter(subject))
      if (!user) throw new ApiError(401, "Invalid or expired authentication token.")
      if (user.isBlocked) throw new ApiError(403, "This account is blocked.")

      request.user = user
      next()
    } catch (error) {
      next(error)
    }
  }

  const requireRole = (...roles) => [
    authenticate,
    (request, _response, next) => {
      if (!roles.includes(request.user.role)) {
        next(new ApiError(403, "You do not have permission to perform this action."))
        return
      }
      next()
    },
  ]

  const listEligibleVendors = async () => {
    const records = await users
      .find({ role: "vendor", isBlocked: { $ne: true } })
      .project({
        name: 1,
        businessName: 1,
        image: 1,
        subscriptionPlan: 1,
        _id: 1,
        id: 1,
      })
      .toArray()
    return records.map((vendor) => ({
      ...vendor,
      id: documentId(vendor),
      name: vendor.businessName || vendor.name,
    }))
  }

  const findOrderById = async (id) => {
    if (!ObjectId.isValid(id)) return null
    return orders.findOne({ _id: new ObjectId(id) })
  }

  const getJoinedOrders = async (records) => {
    const itemIds = [...new Set(records.map((order) => order.itemId))]
      .filter(ObjectId.isValid)
      .map((id) => new ObjectId(id))
    const vendorIds = [...new Set(records.map((order) => order.vendorId))]
    const customerIds = [...new Set(records.map((order) => order.customerId))]

    const [items, vendorRecords, customerRecords] = await Promise.all([
      itemIds.length ? menuItems.find({ _id: { $in: itemIds } }).toArray() : [],
      vendorIds.length
        ? users
            .find({ $or: vendorIds.map((id) => idFilter(id)) })
            .project({ name: 1, businessName: 1, image: 1, _id: 1, id: 1 })
            .toArray()
        : [],
      customerIds.length
        ? users
            .find({ $or: customerIds.map((id) => idFilter(id)) })
            .project({ name: 1, businessName: 1, email: 1, _id: 1, id: 1 })
            .toArray()
        : [],
    ])

    const itemById = new Map(items.map((item) => [String(item._id), item]))
    const vendorById = new Map(
      vendorRecords.map((vendor) => [
        documentId(vendor),
        { ...vendor, name: vendor.businessName || vendor.name },
      ]),
    )
    const customerById = new Map(
      customerRecords.map((customer) => [documentId(customer), customer]),
    )

    return records.map((order) => ({
      ...order,
      id: String(order._id),
      item: itemById.get(order.itemId)
        ? safeMenuItem(itemById.get(order.itemId))
        : null,
      vendor: vendorById.get(order.vendorId) ?? null,
      customer: customerById.get(order.customerId) ?? null,
    }))
  }

  router.get("/users/me", authenticate, (request, response) => {
    response.json({ user: request.user })
  })

  router.patch("/users/profile", authenticate, async (request, response) => {
    if (!["customer", "vendor"].includes(request.user.role)) {
      throw new ApiError(403, "Administrator profiles cannot be edited here.")
    }
    const updates = {}
    const { name, image, businessName } = request.body ?? {}
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
        throw new ApiError(400, "Name must be between 2 and 80 characters.")
      }
      updates.name = name.trim()
    }
    if (image !== undefined) {
      if (image !== null && !isHttpsUrl(image)) {
        throw new ApiError(400, "Profile image must be a valid HTTPS URL.")
      }
      updates.image = image
    }
    if (businessName !== undefined) {
      if (
        request.user.role !== "vendor" ||
        typeof businessName !== "string" ||
        businessName.trim().length < 2 ||
        businessName.trim().length > 120
      ) {
        throw new ApiError(400, "Restaurant name must be between 2 and 120 characters.")
      }
      updates.businessName = businessName.trim()
    }
    if (!Object.keys(updates).length) {
      throw new ApiError(400, "No editable profile fields were provided.")
    }

    const user = await users.findOne(idFilter(request.user.id))
    if (!user) throw new ApiError(404, "User profile not found.")
    updates.updatedAt = new Date()
    await users.updateOne({ _id: user._id }, { $set: updates })
    response.json({
      data: {
        ...request.user,
        ...updates,
        updatedAt: undefined,
      },
    })
  })

  router.post(
    "/uploads/images",
    ...requireRole("customer", "vendor"),
    async (request, response) => {
      const now = Date.now()
      const window = uploadWindows.get(request.user.id)
      if (window && now - window.start < 60_000 && window.count >= 10) {
        throw new ApiError(429, "Too many image uploads. Try again in a minute.")
      }
      uploadWindows.set(
        request.user.id,
        window && now - window.start < 60_000
          ? { start: window.start, count: window.count + 1 }
          : { start: now, count: 1 },
      )

      const apiKey = process.env.IMGBB_API_KEY
      const image = request.body?.image
      if (!apiKey) throw new ApiError(503, "Image uploads are not configured.")
      if (
        typeof image !== "string" ||
        image.length > 5_600_000 ||
        !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)
      ) {
        throw new ApiError(400, "Provide a JPEG, PNG, or WebP image smaller than 4 MB.")
      }

      const form = new FormData()
      form.append("image", image.slice(image.indexOf(",") + 1))
      const uploadUrl = new URL("https://api.imgbb.com/1/upload")
      uploadUrl.searchParams.set("key", apiKey)
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(20_000),
      })
      const result = await uploadResponse.json()
      if (!uploadResponse.ok || result?.success !== true || typeof result?.data?.url !== "string") {
        throw new ApiError(502, "The image hosting service could not accept this image.")
      }

      response.status(201).json({ data: { url: result.data.url } })
    },
  )

  router.get("/categories", (_request, response) => {
    response.json({ data: categories })
  })

  router.get("/menu-items", async (request, response) => {
    response.set("Cache-Control", "no-store")
    const { page, limit } = parsePagination(request.query)
    const vendors = await listEligibleVendors()
    const eligibleVendorIds = vendors.flatMap(vendorIdVariants)
    const filter = {
      status: "approved",
      availability: true,
      vendorId: { $in: eligibleVendorIds },
    }
    const search = String(request.query.search ?? request.query.q ?? "").trim()
    const category = String(request.query.category ?? "").trim()
    const location = String(request.query.location ?? "").trim()
    const sort = String(request.query.sort ?? "")

    if (search) {
      const expression = new RegExp(escapeRegex(search), "i")
      filter.itemName = expression
    }
    if (category) filter.category = { $in: categoryVariants(category) }
    if (location) filter.location = new RegExp(escapeRegex(location), "i")
    if (sort && !["price_asc", "price_desc"].includes(sort)) {
      throw new ApiError(400, "Invalid sort option.")
    }

    const sortBy =
      sort === "price_asc" ? { price: 1, _id: 1 } :
      sort === "price_desc" ? { price: -1, _id: 1 } :
      { approvedAt: -1, createdAt: -1, _id: -1 }

    const [records, total] = await Promise.all([
      menuItems
        .find(filter)
        .sort(sortBy)
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      menuItems.countDocuments(filter),
    ])
    const vendorById = new Map(
      vendors.flatMap((vendor) =>
        vendorIdVariants(vendor).map((vendorId) => [String(vendorId), vendor]),
      ),
    )

    response.json({
      data: records.map((item) => ({
        ...safeMenuItem(item),
        vendor: vendorById.get(String(item.vendorId)) ?? null,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  })

  router.get("/menu-items/featured", async (_request, response) => {
    response.set("Cache-Control", "no-store")
    const vendors = await listEligibleVendors()
    const eligibleVendorIds = vendors.flatMap(vendorIdVariants)
    const vendorById = new Map(
      vendors.flatMap((vendor) =>
        vendorIdVariants(vendor).map((vendorId) => [String(vendorId), vendor]),
      ),
    )
    const premiumIds = vendors
      .filter((vendor) => vendor.subscriptionPlan === "premium")
      .map((vendor) => vendor.id)

    const records = await menuItems
      .find({
        status: "approved",
        availability: true,
        vendorId: { $in: eligibleVendorIds },
      })
      .sort({ approvedAt: -1, createdAt: -1, _id: -1 })
      .limit(30)
      .toArray()
    records.sort((left, right) => {
      const premiumDifference =
        Number(premiumIds.includes(String(right.vendorId))) -
        Number(premiumIds.includes(String(left.vendorId)))
      const approvalTimeDifference =
        new Date(right.approvedAt ?? right.createdAt).getTime() -
        new Date(left.approvedAt ?? left.createdAt).getTime()
      return approvalTimeDifference || premiumDifference
    })

    response.json({
      data: records.slice(0, 6).map((item) => ({
        ...safeMenuItem(item),
        vendor: vendorById.get(String(item.vendorId)) ?? null,
      })),
    })
  })

  router.get("/menu-items/:id", async (request, response) => {
    if (!ObjectId.isValid(request.params.id)) {
      throw new ApiError(400, "Invalid menu item ID.")
    }
    const item = await menuItems.findOne({
      _id: new ObjectId(request.params.id),
      status: "approved",
      availability: true,
    })
    if (!item) throw new ApiError(404, "Menu item not found.")

    const vendor = await users.findOne(idFilter(item.vendorId))
    if (!vendor || vendor.role !== "vendor" || vendor.isBlocked) {
      throw new ApiError(404, "Menu item not found.")
    }
    response.json({
      data: {
        ...safeMenuItem(item),
        vendor: {
          id: documentId(vendor),
          name: vendor.businessName || vendor.name,
          image: vendor.image,
        },
      },
    })
  })

  router.get("/vendor/menu-items", ...requireRole("vendor"), async (request, response) => {
    const records = await menuItems
      .find({ vendorId: request.user.id })
      .sort({ createdAt: -1 })
      .toArray()
    response.json({ data: records.map(safeMenuItem) })
  })

  router.post("/menu-items", ...requireRole("vendor"), async (request, response) => {
    const { itemName, category, description, price, location, images } = request.body ?? {}
    const parsedPrice = Number(price)
    const imageList = Array.isArray(images) ? images : []
    if (
      typeof itemName !== "string" ||
      !itemName.trim() ||
      itemName.trim().length > 100 ||
      !categories.includes(category) ||
      typeof description !== "string" ||
      !description.trim() ||
      description.trim().length > 2000 ||
      !Number.isFinite(parsedPrice) ||
      parsedPrice <= 0 ||
      parsedPrice > 100000 ||
      typeof location !== "string" ||
      !location.trim() ||
      location.trim().length > 120 ||
      imageList.length < 1 ||
      imageList.length > 5 ||
      imageList.some((image) => !isHttpsUrl(image))
    ) {
      throw new ApiError(400, "Please provide valid menu item details and HTTPS image URLs.")
    }

    const now = new Date()
    const item = {
      vendorId: request.user.id,
      itemName: itemName.trim(),
      category,
      description: description.trim(),
      price: parsedPrice,
      location: location.trim(),
      images: imageList,
      status: "pending",
      availability: true,
      createdAt: now,
      updatedAt: now,
    }
    const result = await menuItems.insertOne(item)
    response.status(201).json({ data: { ...item, id: String(result.insertedId) } })
  })

  router.patch("/menu-items/:id", ...requireRole("vendor"), async (request, response) => {
    if (!ObjectId.isValid(request.params.id)) {
      throw new ApiError(400, "Invalid menu item ID.")
    }
    const allowed = ["itemName", "category", "description", "price", "location", "images"]
    const updates = {}
    for (const key of allowed) {
      if (request.body?.[key] !== undefined) updates[key] = request.body[key]
    }
    if (Object.keys(updates).length === 0) {
      throw new ApiError(400, "No editable menu item fields were provided.")
    }
    if ("itemName" in updates && (typeof updates.itemName !== "string" || !updates.itemName.trim() || updates.itemName.length > 100)) {
      throw new ApiError(400, "Invalid menu item name.")
    }
    if ("category" in updates && !categories.includes(updates.category)) {
      throw new ApiError(400, "Invalid menu category.")
    }
    if ("description" in updates && (typeof updates.description !== "string" || updates.description.length > 2000)) {
      throw new ApiError(400, "Invalid menu item description.")
    }
    if ("price" in updates && (!Number.isFinite(Number(updates.price)) || Number(updates.price) <= 0 || Number(updates.price) > 100000)) {
      throw new ApiError(400, "Invalid menu item price.")
    }
    if ("location" in updates && (typeof updates.location !== "string" || !updates.location.trim() || updates.location.length > 120)) {
      throw new ApiError(400, "Invalid menu item location.")
    }
    if (
      "images" in updates &&
      (!Array.isArray(updates.images) ||
        updates.images.length < 1 ||
        updates.images.length > 5 ||
        updates.images.some((image) => !isHttpsUrl(image)))
    ) {
      throw new ApiError(400, "Provide between 1 and 5 menu item images.")
    }

    if ("itemName" in updates) updates.itemName = updates.itemName.trim()
    if ("description" in updates) updates.description = updates.description.trim()
    if ("location" in updates) updates.location = updates.location.trim()
    if ("price" in updates) updates.price = Number(updates.price)
    updates.status = "pending"
    updates.updatedAt = new Date()
    const result = await menuItems.findOneAndUpdate(
      { _id: new ObjectId(request.params.id), vendorId: request.user.id },
      { $set: updates, $unset: { approvedAt: "" } },
      { returnDocument: "after" },
    )
    if (!result) throw new ApiError(404, "Menu item not found.")
    response.json({ data: safeMenuItem(result) })
  })

  router.delete("/menu-items/:id", ...requireRole("vendor"), async (request, response) => {
    if (!ObjectId.isValid(request.params.id)) {
      throw new ApiError(400, "Invalid menu item ID.")
    }
    const result = await menuItems.deleteOne({
      _id: new ObjectId(request.params.id),
      vendorId: request.user.id,
    })
    if (!result.deletedCount) throw new ApiError(404, "Menu item not found.")
    response.status(204).end()
  })

  router.patch("/menu-items/:id/availability", ...requireRole("vendor"), async (request, response) => {
    if (!ObjectId.isValid(request.params.id) || typeof request.body?.availability !== "boolean") {
      throw new ApiError(400, "Invalid item ID or availability value.")
    }
    const filter = { _id: new ObjectId(request.params.id), vendorId: request.user.id }
    const item = await menuItems.findOne(filter)
    if (!item) throw new ApiError(404, "Menu item not found.")

    if (request.body.availability && item.status === "approved" && request.user.subscriptionPlan !== "premium") {
      const activeCount = await menuItems.countDocuments({
        vendorId: request.user.id,
        status: "approved",
        availability: true,
      })
      if (activeCount >= 3 && !item.availability) {
        throw new ApiError(409, "Free vendors can have at most 3 active menu items.")
      }
    }

    await menuItems.updateOne(filter, {
      $set: { availability: request.body.availability, updatedAt: new Date() },
    })
    response.json({ data: { id: String(item._id), availability: request.body.availability } })
  })

  router.get("/admin/menu-items", ...requireRole("admin"), async (request, response) => {
    const { page, limit } = parsePagination(request.query)
    const filter = {}
    if (request.query.status) filter.status = String(request.query.status)
    if (request.query.category) filter.category = String(request.query.category)
    if (request.query.vendorId) filter.vendorId = String(request.query.vendorId)
    const [records, total] = await Promise.all([
      menuItems
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      menuItems.countDocuments(filter),
    ])
    response.json({
      data: records.map(safeMenuItem),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  })

  router.patch("/admin/menu-items/:id/status", ...requireRole("admin"), async (request, response) => {
    const status = request.body?.status
    if (!ObjectId.isValid(request.params.id) || !["pending", "approved", "rejected", "inactive"].includes(status)) {
      throw new ApiError(400, "Invalid menu item ID or status.")
    }
    const item = await menuItems.findOne({ _id: new ObjectId(request.params.id) })
    if (!item) throw new ApiError(404, "Menu item not found.")

    if (status === "approved") {
      const vendor = await users.findOne(idFilter(item.vendorId))
      if (!vendor || vendor.isBlocked) throw new ApiError(409, "Blocked or missing vendors cannot publish items.")
      if (vendor.subscriptionPlan !== "premium") {
        const activeCount = await menuItems.countDocuments({
          vendorId: item.vendorId,
          status: "approved",
          availability: true,
        })
        if (item.availability && item.status !== "approved" && activeCount >= 3) {
          throw new ApiError(409, "This vendor has reached the 3-item free plan limit.")
        }
      }
    }

    const updatedAt = new Date()
    await menuItems.updateOne(
      { _id: item._id },
      {
        $set: {
          status,
          updatedAt,
          ...(status === "approved" ? { approvedAt: updatedAt } : {}),
        },
        ...(status === "approved" ? {} : { $unset: { approvedAt: "" } }),
      },
    )

    // Increment cache-busting version so customer pages refetch approved items
    try {
      const currentVersion = Number(localStorage.getItem("pizzoraMenuApprovalVersion") || "0")
      localStorage.setItem("pizzoraMenuApprovalVersion", String(currentVersion + 1))
    } catch (e) {
      // localStorage may not be available in all environments; ignore
    }

    response.json({ data: { id: String(item._id), status } })
  })

  router.delete("/admin/menu-items/:id", ...requireRole("admin"), async (request, response) => {
    if (!ObjectId.isValid(request.params.id)) throw new ApiError(400, "Invalid menu item ID.")
    const result = await menuItems.deleteOne({ _id: new ObjectId(request.params.id) })
    if (!result.deletedCount) throw new ApiError(404, "Menu item not found.")
    response.status(204).end()
  })

  router.post("/orders", ...requireRole("customer"), async (request, response) => {
    const { itemId, deliveryDate, deliveryAddress, message = "" } = request.body ?? {}
    if (
      typeof itemId !== "string" ||
      !ObjectId.isValid(itemId) ||
      typeof deliveryDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) ||
      Number.isNaN(Date.parse(`${deliveryDate}T00:00:00.000Z`)) ||
      deliveryDate < new Date().toISOString().slice(0, 10) ||
      typeof deliveryAddress !== "string" ||
      !deliveryAddress.trim() ||
      deliveryAddress.trim().length > 500 ||
      typeof message !== "string" ||
      message.length > 1000
    ) {
      throw new ApiError(400, "Please provide a valid item, delivery date, and address.")
    }

    const item = await menuItems.findOne({
      _id: new ObjectId(itemId),
      status: "approved",
      availability: true,
    })
    if (!item) throw new ApiError(404, "This menu item is unavailable.")
    if (item.vendorId === request.user.id) {
      throw new ApiError(403, "You cannot order your own menu item.")
    }
    const vendor = await users.findOne(idFilter(item.vendorId))
    if (!vendor || vendor.role !== "vendor" || vendor.isBlocked) {
      throw new ApiError(409, "This restaurant is currently unavailable.")
    }

    const now = new Date()
    const order = {
      itemId,
      vendorId: item.vendorId,
      customerId: request.user.id,
      deliveryDate,
      deliveryAddress: deliveryAddress.trim(),
      message: message.trim(),
      status: "pending",
      activeOrderKey: `${request.user.id}:${itemId}:${deliveryDate}`,
      createdAt: now,
      updatedAt: now,
    }
    try {
      const result = await orders.insertOne(order)
      response.status(201).json({ data: { ...order, id: String(result.insertedId) } })
    } catch (error) {
      if (error?.code === 11000) {
        throw new ApiError(409, "You already have an active order for this item and date.")
      }
      throw error
    }
  })

  router.get("/orders/my-orders", ...requireRole("customer"), async (request, response) => {
    const records = await orders
      .find({ customerId: request.user.id })
      .sort({ createdAt: -1 })
      .toArray()
    response.json({ data: await getJoinedOrders(records) })
  })

  router.get("/vendor/orders", ...requireRole("vendor"), async (request, response) => {
    const records = await orders
      .find({ vendorId: request.user.id })
      .sort({ createdAt: -1 })
      .toArray()
    response.json({ data: await getJoinedOrders(records) })
  })

  router.patch("/orders/:id/:action", authenticate, async (request, response) => {
    const { id, action } = request.params
    if (!ObjectId.isValid(id) || !["accept", "reject", "cancel"].includes(action)) {
      throw new ApiError(400, "Invalid order action.")
    }
    const order = await findOrderById(id)
    if (!order) throw new ApiError(404, "Order not found.")

    const isVendorAction = action === "accept" || action === "reject"
    if (isVendorAction && request.user.role !== "vendor") {
      throw new ApiError(403, "Only vendors can process orders.")
    }
    if (action === "cancel" && request.user.role !== "customer") {
      throw new ApiError(403, "Only customers can cancel orders.")
    }
    if (
      (isVendorAction && order.vendorId !== request.user.id) ||
      (action === "cancel" && order.customerId !== request.user.id)
    ) {
      throw new ApiError(404, "Order not found.")
    }

    const status = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "cancelled"
    const update = {
      $set: { status, updatedAt: new Date() },
      ...(status === "accepted" ? {} : { $unset: { activeOrderKey: "" } }),
    }
    const result = await orders.updateOne(
      { _id: order._id, status: "pending" },
      update,
    )
    if (!result.modifiedCount) {
      throw new ApiError(409, "Only pending orders can be processed.")
    }
    response.json({ data: { id, status } })
  })

  router.get("/dashboard/customer", ...requireRole("customer"), async (request, response) => {
    const filter = { customerId: request.user.id }
    const [totalOrders, pendingOrders, acceptedOrders, rejectedOrders, recent] =
      await Promise.all([
        orders.countDocuments(filter),
        orders.countDocuments({ ...filter, status: "pending" }),
        orders.countDocuments({ ...filter, status: "accepted" }),
        orders.countDocuments({ ...filter, status: "rejected" }),
        orders.find(filter).sort({ createdAt: -1 }).limit(5).toArray(),
      ])
    response.json({
      data: {
        totalOrders,
        pendingOrders,
        acceptedOrders,
        rejectedOrders,
        recentOrders: await getJoinedOrders(recent),
      },
    })
  })

  router.get("/dashboard/vendor", ...requireRole("vendor"), async (request, response) => {
    const ownOrders = { vendorId: request.user.id }
    const ownItems = { vendorId: request.user.id }
    const [totalItems, activeItems, pendingOrders, acceptedOrders] = await Promise.all([
      menuItems.countDocuments(ownItems),
      menuItems.countDocuments({ ...ownItems, status: "approved", availability: true }),
      orders.countDocuments({ ...ownOrders, status: "pending" }),
      orders.countDocuments({ ...ownOrders, status: "accepted" }),
    ])
    response.json({
      data: {
        totalItems,
        activeItems,
        pendingOrders,
        acceptedOrders,
        subscriptionPlan: request.user.subscriptionPlan || "free",
      },
    })
  })

  router.get("/dashboard/admin", ...requireRole("admin"), async (_request, response) => {
    const [totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions] =
      await Promise.all([
        users.countDocuments({}),
        users.countDocuments({ role: "vendor" }),
        users.countDocuments({ role: "customer" }),
        menuItems.countDocuments({}),
        menuItems.countDocuments({ status: "pending" }),
        transactions.countDocuments({}),
      ])
    response.json({
      data: {
        totalUsers,
        totalVendors,
        totalCustomers,
        totalMenuItems,
        pendingMenuItems,
        totalTransactions,
      },
    })
  })

  router.get("/subscriptions/current", ...requireRole("vendor"), (request, response) => {
    response.json({
      data: {
        plan: request.user.subscriptionPlan || "free",
        expiresAt: request.user.subscriptionExpiresAt ?? null,
        cancelAtPeriodEnd: request.user.subscriptionCancelAtPeriodEnd ?? false,
      },
    })
  })

  router.post("/subscriptions/checkout", ...requireRole("vendor"), async (request, response) => {
    if (!stripe || !process.env.STRIPE_PRICE_ID) {
      throw new ApiError(503, "Premium checkout is not configured.")
    }

    const expiresAt = request.user.subscriptionExpiresAt
    if (
      request.user.subscriptionPlan === "premium" &&
      (!expiresAt || new Date(expiresAt).getTime() > Date.now())
    ) {
      throw new ApiError(409, "Your account already has an active Premium plan.")
    }

    const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000")
      .split(",")[0]
      .trim()
      .replace(/\/+$/, "")
    const checkout = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: request.user.id,
      customer_email: request.user.email,
      metadata: { vendorId: request.user.id },
      subscription_data: { metadata: { vendorId: request.user.id } },
      success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment/cancel`,
    })

    response.json({ data: { url: checkout.url } })
  })

  router.post("/subscriptions/cancel", ...requireRole("vendor"), async (request, response) => {
    if (!stripe) throw new ApiError(503, "Subscription management is not configured.")
    if (
      request.user.subscriptionPlan !== "premium" ||
      !request.user.stripeSubscriptionId
    ) {
      throw new ApiError(409, "There is no active Premium subscription to cancel.")
    }

    const subscription = await stripe.subscriptions.update(
      request.user.stripeSubscriptionId,
      { cancel_at_period_end: true },
    )
    response.json({
      data: {
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        expiresAt: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null,
      },
    })
  })

  router.get("/admin/users", ...requireRole("admin"), async (request, response) => {
    const { page, limit } = parsePagination(request.query)
    const filter = {}
    const role = String(request.query.role ?? "")
    if (role && ["customer", "vendor", "admin"].includes(role)) filter.role = role
    const search = String(request.query.search ?? "").trim()
    if (search) {
      const expression = new RegExp(escapeRegex(search), "i")
      filter.$or = [{ name: expression }, { email: expression }]
    }
    const [records, total] = await Promise.all([
      users
        .find(filter)
        .project({ name: 1, email: 1, image: 1, role: 1, isBlocked: 1, createdAt: 1, _id: 1, id: 1 })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      users.countDocuments(filter),
    ])
    response.json({
      data: records.map((user) => ({ ...user, id: documentId(user), _id: undefined })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  })

  router.patch("/admin/users/:id/block", ...requireRole("admin"), async (request, response) => {
    if (!request.params.id || request.params.id.length > 128) {
      throw new ApiError(400, "Invalid user ID.")
    }
    const filter = idFilter(request.params.id)
    if (request.params.id === request.user.id) throw new ApiError(403, "You cannot block your own admin account.")
    const target = await users.findOne(filter)
    if (!target) throw new ApiError(404, "User not found.")
    await users.updateOne({ _id: target._id }, { $set: { isBlocked: true } })
    response.json({ data: { id: documentId(target), isBlocked: true } })
  })

  router.patch("/admin/users/:id/unblock", ...requireRole("admin"), async (request, response) => {
    if (!request.params.id || request.params.id.length > 128) {
      throw new ApiError(400, "Invalid user ID.")
    }
    const filter = idFilter(request.params.id)
    const target = await users.findOne(filter)
    if (!target) throw new ApiError(404, "User not found.")
    await users.updateOne({ _id: target._id }, { $set: { isBlocked: false } })
    response.json({ data: { id: documentId(target), isBlocked: false } })
  })

  router.get("/admin/transactions", ...requireRole("admin"), async (request, response) => {
    const { page, limit } = parsePagination(request.query)
    const [records, total] = await Promise.all([
      transactions
        .find({})
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      transactions.countDocuments({}),
    ])
    response.json({
      data: records.map((transaction) => ({
        ...transaction,
        id: String(transaction._id),
        _id: undefined,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  })

  router.use((error, _request, response, _next) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: error.message })
      return
    }
    console.error(error)
    response.status(500).json({ error: "An unexpected server error occurred." })
  })

  return router
}
