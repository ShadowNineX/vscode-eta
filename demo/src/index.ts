import { Eta } from "eta";
import * as path from "node:path";
import type {
  User,
  Product,
  Order,
  Comment,
  BlogPost,
  Notification,
  CartItem,
  Cart,
} from "./types";

const eta = new Eta({ views: path.join(__dirname, "../views") });

// ── render() calls ────────────────────────────────────────────────────────────
// The extension scans these and infers the `it` type for each template file.

// user.eta  →  it: { name: string; age: number; bio?: string; role: string }
const user: User = { name: "Ben", age: 30, role: "admin" };
console.log(eta.render("user", user));

// product.eta  →  it: { title: string; price: number; inStock: boolean; tags: string[] }
const product: Product = {
  title: "Widget Pro",
  price: 49.99,
  inStock: true,
  tags: ["new", "featured", "sale"],
};
console.log(eta.render("product", product));

// greeting.eta  →  it: { heading: string; count: number }
// (inline object literal — no interface needed; extension still infers the type)
console.log(eta.render("greeting", { heading: "Hello, world!", count: 3 }));

// order.eta  →  it: { id: number; customer: { name: string; … }; items: { title: string; … }[]; total: number }
// Demonstrates recursive structural expansion of nested types.
const order: Order = {
  id: 1001,
  customer: user,
  items: [product],
  total: product.price,
};
console.log(eta.render("order", order));

// render() also works with just the template name (views dir is pre-configured)
// dashboard.eta  →  it: { title: string; stats: { visits: number; revenue: number } }
console.log(
  eta.render("dashboard", {
    title: "Weekly Report",
    stats: { visits: 1_240, revenue: 3_890.5 },
  }),
);

// ── Complex types ─────────────────────────────────────────────────────────────

// blog-post.eta  →  it: { slug: string; title: string; author: { name: …; role: … }; tags: string[];
//                          comments: { id: number; author: string; … }[]; status: "draft"|…; … }
// Tests: nested object, string[], array of objects, union string literal, optional property.
const comment1: Comment = {
  id: 1,
  author: "Alice",
  body: "Great post!",
  likes: 5,
  createdAt: "2026-05-01",
};
const comment2: Comment = {
  id: 2,
  author: "Bob",
  body: "Very useful.",
  likes: 3,
  createdAt: "2026-05-02",
};
const post: BlogPost = {
  slug: "hello-world",
  title: "Hello, World!",
  body: "<p>My first post.</p>",
  author: user,
  tags: ["typescript", "eta", "templates"],
  comments: [comment1, comment2],
  publishedAt: "2026-05-17",
  status: "published",
  featuredImage: "/images/hero.jpg",
  viewCount: 1_024,
};
console.log(eta.render("blog-post", post));

// notification.eta  →  it: { type: "info"|"warning"|"error"|"success"; title: string;
//                             message: string; actionLabel?: string; actionUrl?: string; dismissible: boolean }
// Tests: union type, optional properties, boolean.
const notif: Notification = {
  type: "warning",
  title: "Heads up",
  message: "Your session expires in 5 minutes.",
  actionLabel: "Renew",
  actionUrl: "/renew",
  dismissible: true,
};
console.log(eta.render("notification", notif));

// cart.eta  →  it: { items: { product: { title: string; price: number; … }; quantity: number; lineTotal: number }[];
//                    discountCode?: string; subtotal: number; tax: number; total: number }
// Tests: array of objects with their own nested object, optional string, multiple numbers.
const cartItem: CartItem = {
  product,
  quantity: 2,
  lineTotal: product.price * 2,
};
const cart: Cart = {
  items: [cartItem],
  discountCode: "SAVE10",
  subtotal: cartItem.lineTotal,
  tax: cartItem.lineTotal * 0.1,
  total: cartItem.lineTotal * 1.1,
};
console.log(eta.render("cart", cart));
