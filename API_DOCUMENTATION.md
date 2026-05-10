# Bhumivera Backend API Documentation

**Base URL:** `https://service.Bhumivera.com`  
**Version:** 3.1  
**Database:** MySQL (Railway)  
**Storage:** AWS S3 + CloudFront  
**Auth:** JWT (Bearer Token)

---

## Authentication

All protected routes require `Authorization: Bearer <token>` header.

- **Admin routes** require a JWT with `role: 'admin'`
- **User routes** require any valid JWT

### Auth Middleware
- `authenticateAdmin` — Admin-only access
- `authenticateUser` — Logged-in user access

---

## Health Check

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | None | API health check |

**Response:**
```json
{"status": "ok", "message": "Bhumivera API running", "version": "3.1"}
```

---

## Auth Routes — `/api/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | None | Register new customer |
| POST | `/api/auth/login` | None | Login customer |
| POST | `/api/auth/admin/login` | None | Admin login |

---

## User Routes — `/api/users`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/users/me` | User | Get own profile |
| PUT | `/api/users/me` | User | Update own profile |
| PUT | `/api/users/me/password` | User | Change password |

---

## Product Routes — `/api/products`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/products` | None | Get all active products (with filters) |
| GET | `/api/products/all` | Admin | Get all products including inactive |
| GET | `/api/products/:id` | None | Get product by ID |
| GET | `/api/products/slug/:slug` | None | Get product by slug |
| POST | `/api/products` | Admin | Create new product |
| PUT | `/api/products/:id` | Admin | Update product |
| PATCH | `/api/products/:id/status` | Admin | Toggle product status |
| POST | `/api/products/:id/images` | Admin | Upload product images |
| DELETE | `/api/products/:id/images` | Admin | Delete product image |
| POST | `/api/products/:id/serials` | Admin | Add serial number |
| DELETE | `/api/products/:id` | Admin | Delete product |

**Query filters for GET /api/products:**
- `category_id` — Filter by category
- `subcategory_id` — Filter by subcategory
- `min_price`, `max_price` — Price range
- `search` — Full-text search
- `sort` — `price_asc`, `price_desc`, `newest`, `name_asc`

---

## Category Routes — `/api/categories`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/categories` | None | List all categories |
| GET | `/api/categories/:id` | None | Get category by ID |
| POST | `/api/categories` | Admin | Create category |
| PUT | `/api/categories/:id` | Admin | Update category |
| DELETE | `/api/categories/:id` | Admin | Delete category |

---

## Subcategory Routes — `/api/subcategories`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/subcategories` | None | List all subcategories |
| GET | `/api/subcategories/:id` | None | Get subcategory by ID |
| POST | `/api/subcategories` | Admin | Create subcategory |
| PUT | `/api/subcategories/:id` | Admin | Update subcategory |
| DELETE | `/api/subcategories/:id` | Admin | Delete subcategory |

---

## Cart Routes — `/api/cart`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/cart` | User | Get user's cart |
| POST | `/api/cart` | User | Add item to cart |
| PUT | `/api/cart/:id` | User | Update cart item quantity |
| DELETE | `/api/cart/:id` | User | Remove item from cart |
| DELETE | `/api/cart` | User | Clear entire cart |

---

## Order Routes — `/api/orders`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/orders/my` | User | Get user's orders |
| GET | `/api/orders/:id` | User | Get order by ID |
| POST | `/api/orders` | User | Create new order |
| GET | `/api/orders` | Admin | Get all orders |
| PATCH | `/api/orders/:id/status` | Admin | Update order status |
| DELETE | `/api/orders/:id` | Admin | Delete order |

---

## Address Routes — `/api/addresses`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/addresses` | User | Get user's addresses |
| POST | `/api/addresses` | User | Add new address |
| PUT | `/api/addresses/:id` | User | Update address |
| DELETE | `/api/addresses/:id` | User | Delete address |
| PATCH | `/api/addresses/:id/default` | User | Set default address |

---

## Wishlist Routes — `/api/wishlist`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/wishlist` | User | Get user's wishlist |
| POST | `/api/wishlist` | User | Add item to wishlist |
| DELETE | `/api/wishlist/:productId` | User | Remove item from wishlist |

---

## Coupon Routes — `/api/coupons`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/coupons/validate` | User | Validate coupon code |
| GET | `/api/coupons` | Admin | List all coupons |
| POST | `/api/coupons` | Admin | Create new coupon |
| PUT | `/api/coupons/:id` | Admin | Update coupon |
| DELETE | `/api/coupons/:id` | Admin | Delete coupon |

---

## Review Routes — `/api/reviews`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/reviews/product/:productId` | None | Get reviews for a product |
| POST | `/api/reviews` | User | Submit a review |
| DELETE | `/api/reviews/:id` | Admin | Delete a review |

---

## Notification Routes — `/api/notifications`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/notifications` | User | Get user's notifications |
| PATCH | `/api/notifications/:id/read` | User | Mark notification as read |
| PATCH | `/api/notifications/read-all` | User | Mark all as read |
| POST | `/api/notifications` | Admin | Send notification to user |

---

## Analytics Routes — `/api/analytics`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/analytics/dashboard` | Admin | Dashboard stats overview |
| GET | `/api/analytics/sales` | Admin | Sales analytics |
| GET | `/api/analytics/products` | Admin | Product performance stats |

---

## Settings Routes — `/api/settings`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/settings` | Admin | Get site settings |
| PUT | `/api/settings` | Admin | Update site settings |

---

## Shipping Routes — `/api/shipping`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/shipping` | Admin | Get all shipping rules |
| POST | `/api/shipping` | Admin | Create shipping rule |
| PUT | `/api/shipping/:id` | Admin | Update shipping rule |
| DELETE | `/api/shipping/:id` | Admin | Delete shipping rule |

---

## Return Routes — `/api/returns`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/returns/my` | User | Get user's return requests |
| POST | `/api/returns` | User | Submit return request |
| GET | `/api/returns` | Admin | Get all return requests |
| PATCH | `/api/returns/:id/status` | Admin | Update return status |

---

## Inventory Routes — `/api/inventory`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/inventory` | Admin | Get inventory status |
| PATCH | `/api/inventory/:productId` | Admin | Update stock quantity |

---

## Banner Routes — `/api/banners`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/banners` | None | Get active banners |
| GET | `/api/banners/all` | Admin | Get all banners |
| POST | `/api/banners` | Admin | Create banner |
| PUT | `/api/banners/:id` | Admin | Update banner |
| DELETE | `/api/banners/:id` | Admin | Delete banner |

---

## Warranty Routes — `/api/warranty`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/warranty/register` | User | Register warranty |
| GET | `/api/warranty/my` | User | Get user's warranties |
| GET | `/api/warranty` | Admin | Get all warranty registrations |
| PATCH | `/api/warranty/:id/status` | Admin | Accept/reject warranty |

---

## Serial Number Routes — `/api/serials`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/serials/validate` | User | Validate serial number |
| GET | `/api/serials` | Admin | List all serials |
| POST | `/api/serials` | Admin | Add serial numbers |
| DELETE | `/api/serials/:id` | Admin | Delete serial |

---

## Contact Routes — `/api/contact`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/contact` | None | Submit contact form |
| GET | `/api/contact` | Admin | Get all contact submissions |
| DELETE | `/api/contact/:id` | Admin | Delete contact submission |

---

## Admin User Management — `/api/admin`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/admin/users` | Admin | List all customers |
| GET | `/api/admin/users/:id` | Admin | Get customer details |
| PATCH | `/api/admin/users/:id/status` | Admin | Enable/disable user |
| GET | `/api/admin/orders` | Admin | Get all orders (admin view) |

---

## Error Responses

| Status | Meaning |
|--------|----------|
| 400 | Bad Request — missing/invalid input |
| 401 | Unauthorized — missing or invalid token |
| 403 | Forbidden — admin-only resource |
| 404 | Not Found — resource doesn't exist |
| 409 | Conflict — e.g., duplicate or constraint violation |
| 500 | Internal Server Error |

---

## Tech Stack

- **Runtime:** Node.js 22.x
- **Framework:** Express 5.x
- **Database:** MySQL 8 (Railway managed)
- **ORM:** Raw SQL via mysql2
- **Auth:** JSON Web Tokens (JWT)
- **Storage:** AWS S3 + CloudFront CDN
- **Email:** Mailjet via node-mailjet
- **Upload:** Multer + multer-s3
- **Deploy:** Railway (auto-deploy from GitHub)

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 5000) |
| `JWT_SECRET` | Secret for JWT signing |
| `DB_HOST` | MySQL host |
| `DB_USER` | MySQL username |
| `DB_PASSWORD` | MySQL password |
| `DB_NAME` | MySQL database name |
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret |
| `AWS_REGION` | S3 region |
| `S3_BUCKET_NAME` | S3 bucket name |
| `CLOUDFRONT_BASE_URL` | CloudFront base URL for images |
| `MAILJET_API_KEY` | Mailjet API key |
| `MAILJET_SECRET_KEY` | Mailjet secret key |
