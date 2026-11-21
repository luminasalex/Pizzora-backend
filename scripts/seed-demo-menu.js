import "dotenv/config"
import { MongoClient } from "mongodb"

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required.")
}

const demoVendors = [
  {
    email: "demo.vendor1@pizzora.local",
    name: "Pizza Roma",
    businessName: "Pizza Roma",
  },
  {
    email: "demo.vendor2@pizzora.local",
    name: "Urban Crust",
    businessName: "Urban Crust",
  },
  {
    email: "demo.vendor3@pizzora.local",
    name: "The Oven House",
    businessName: "The Oven House",
  },
]

const demos = [
  ["classic-margherita", "Classic Margherita", "Classic Pizzas", "Fresh tomato sauce, mozzarella and basil.", 650, "Dhanmondi, Dhaka", "https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=900&q=85"],
  ["classic-pepperoni", "Pepperoni Feast", "Classic Pizzas", "Pepperoni, mozzarella and house tomato sauce.", 850, "Banani, Dhaka", "https://images.unsplash.com/photo-1628840042765-356cda07504e?auto=format&fit=crop&w=900&q=85"],
  ["classic-cheese", "Four Cheese Pizza", "Classic Pizzas", "Mozzarella, cheddar, parmesan and cream cheese.", 790, "Gulshan, Dhaka", "https://images.unsplash.com/photo-1579751626657-72bc17010498?auto=format&fit=crop&w=900&q=85"],
  ["vegetarian-garden", "Garden Veggie Pizza", "Vegetarian Pizzas", "Capsicum, mushrooms, olives and sweet corn.", 720, "Mirpur, Dhaka", "https://images.unsplash.com/photo-1571997478779-2adcbbe9ab2f?auto=format&fit=crop&w=900&q=85"],
  ["vegetarian-spinach", "Spinach & Feta Pizza", "Vegetarian Pizzas", "Spinach, feta cheese, tomato and oregano.", 760, "Uttara, Dhaka", "https://images.unsplash.com/photo-1548365328-9f547fb0953c?auto=format&fit=crop&w=900&q=85"],
  ["vegetarian-paneer", "Paneer Tikka Pizza", "Vegetarian Pizzas", "Tandoori paneer, onion and green pepper.", 820, "Mohammadpur, Dhaka", "https://images.unsplash.com/photo-1593560708920-61dd98c46a4e?auto=format&fit=crop&w=900&q=85"],
  ["meat-chicken", "Smoky Chicken Pizza", "Meat Lovers", "Grilled chicken, onion and smoky barbecue sauce.", 920, "Tejgaon, Dhaka", "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=900&q=85"],
  ["meat-beef", "Beef Supreme", "Meat Lovers", "Seasoned beef, pepperoni and jalapeno.", 980, "Bashundhara, Dhaka", "https://images.unsplash.com/photo-1594007654729-407eedc4be65?auto=format&fit=crop&w=900&q=85"],
  ["meat-sausage", "Italian Sausage Pizza", "Meat Lovers", "Italian sausage, mushroom and mozzarella.", 890, "Dhanmondi, Dhaka", "https://images.unsplash.com/photo-1604382355076-af4b0eb60143?auto=format&fit=crop&w=900&q=85"],
  ["special-pesto", "Chicken Pesto Gourmet", "Specialty / Gourmet Pizzas", "Chicken, pesto, cherry tomato and mozzarella.", 1050, "Banani, Dhaka", "https://images.unsplash.com/photo-1571407970349-bc81e7e96d47?auto=format&fit=crop&w=900&q=85"],
  ["special-truffle", "Truffle Mushroom Pizza", "Specialty / Gourmet Pizzas", "Mushroom, truffle oil and parmesan.", 1150, "Gulshan, Dhaka", "https://images.unsplash.com/photo-1598023696416-0193a0bcd302?auto=format&fit=crop&w=900&q=85"],
  ["special-bbq", "BBQ Ranch Special", "Specialty / Gourmet Pizzas", "Barbecue chicken, ranch and red onion.", 1080, "Uttara, Dhaka", "https://images.unsplash.com/photo-1595708684082-a173bb3a06c5?auto=format&fit=crop&w=900&q=85"],
  ["side-garlic-bread", "Cheesy Garlic Bread", "Sides & Appetizers", "Oven-baked bread with garlic butter and cheese.", 320, "Dhanmondi, Dhaka", "https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?auto=format&fit=crop&w=900&q=85"],
  ["side-wings", "Honey BBQ Wings", "Sides & Appetizers", "Six honey-barbecue chicken wings.", 480, "Mirpur, Dhaka", "https://images.unsplash.com/photo-1527477396000-e27163b481c2?auto=format&fit=crop&w=900&q=85"],
  ["side-fries", "Loaded Fries", "Sides & Appetizers", "Crispy fries topped with cheese and herbs.", 380, "Tejgaon, Dhaka", "https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=900&q=85"],
  ["drink-lemonade", "Fresh Lemonade", "Beverages & Desserts", "Chilled lemon and mint refreshment.", 180, "Gulshan, Dhaka", "https://images.unsplash.com/photo-1523677011781-c91d1bbe2f9e?auto=format&fit=crop&w=900&q=85"],
  ["dessert-brownie", "Chocolate Brownie", "Beverages & Desserts", "Warm chocolate brownie with chocolate sauce.", 350, "Banani, Dhaka", "https://images.unsplash.com/photo-1606313564200-e75d5e30476c?auto=format&fit=crop&w=900&q=85"],
  ["dessert-tiramisu", "Classic Tiramisu", "Beverages & Desserts", "Coffee-soaked dessert with mascarpone cream.", 420, "Bashundhara, Dhaka", "https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?auto=format&fit=crop&w=900&q=85"],
]

const client = new MongoClient(process.env.MONGODB_URI)

try {
  await client.connect()
  const db = client.db(process.env.DB_NAME || "Pizzora")
  const users = db.collection("user")
  const menuItems = db.collection("menuItems")

  let vendors = await users
    .find({ role: "vendor", isBlocked: { $ne: true } })
    .limit(6)
    .toArray()

  if (!vendors.length) {
    const now = new Date()
    const vendorIds = []

    for (const vendor of demoVendors) {
      const result = await users.updateOne(
        { email: vendor.email },
        {
          $set: {
            ...vendor,
            emailVerified: true,
            role: "vendor",
            isBlocked: false,
            subscriptionPlan: "premium",
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      )

      const record = await users.findOne({ email: vendor.email })
      if (record) vendorIds.push(record)
    }
    vendors = vendorIds
  }

  const now = new Date()
  let inserted = 0
  let updated = 0

  for (let index = 0; index < demos.length; index += 1) {
    const [seedKey, itemName, category, description, price, location, image] = demos[index]
    const vendor = vendors[index % vendors.length]
    const vendorId = String(vendor.id ?? vendor._id)
    const result = await menuItems.updateOne(
      { seedKey },
      {
        $set: {
          seedKey,
          vendorId,
          itemName,
          category,
          description,
          price,
          location,
          images: [image],
          status: "approved",
          availability: true,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    )
    inserted += result.upsertedCount
    updated += result.modifiedCount
  }

  console.log(`Demo menu ready: ${demos.length} items (inserted ${inserted}, updated ${updated}).`)
} finally {
  await client.close()
}
