// Shared types used across render calls.
// The extension expands these interfaces structurally so templates see
// concrete property types — no imports needed inside the virtual TS file.

export interface User {
  name: string;
  age: number;
  bio?: string;
  role: "admin" | "editor" | "viewer";
}

export interface Product {
  title: string;
  price: number;
  inStock: boolean;
  tags: string[];
}

export interface Order {
  id: number;
  customer: User; // nested — extension expands this recursively
  items: Product[];
  total: number;
}

// ── Complex types ─────────────────────────────────────────────────────────────

export interface Comment {
  id: number;
  author: string;
  body: string;
  likes: number;
  createdAt: string;
}

export interface BlogPost {
  slug: string;
  title: string;
  body: string;
  author: User;
  tags: string[];
  comments: Comment[];
  publishedAt: string;
  status: "draft" | "published" | "archived";
  featuredImage?: string;
  viewCount: number;
}

export type NotificationType = "info" | "warning" | "error" | "success";

export interface Notification {
  type: NotificationType;
  title: string;
  message: string;
  actionLabel?: string;
  actionUrl?: string;
  dismissible: boolean;
}

export interface CartItem {
  product: Product;
  quantity: number;
  lineTotal: number;
}

export interface Cart {
  items: CartItem[];
  discountCode?: string;
  subtotal: number;
  tax: number;
  total: number;
}
