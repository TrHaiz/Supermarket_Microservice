# Supermarket Backend — Microservices Architecture

Backend hệ thống quản lý siêu thị mini, xây dựng theo kiến trúc Microservices với Node.js, Express, MongoDB, Redis, Docker Compose và Nginx reverse proxy.

---

## 1. Kiến trúc hệ thống

```
Clients (Web / App / Postman)
              │
              ▼
   [Nginx Reverse Proxy :8088]
              │
              ▼
    [API Gateway :3000]
     ├── Rate Limiter (express-rate-limit)
     ├── JWT Authentication & RBAC (ADMIN / STAFF)
     └── Dynamic Round-Robin Proxy
              │
     ┌────────┼────────┬─────────────────┐
     ▼        ▼        ▼                 ▼
[Auth]   [Product] [Inventory]       [Order]
:3002      :3001     :3003             :3004
  │          │         │                 │
 MongoDB     ├─────────┴─────────────────┤
 (Auth)      │       Internal REST       │
             ▼                           ▼
          MongoDB                     MongoDB
         (Product)                   (Inventory & Order)
             │
           Redis
         (Cache 60s)
```

---

## 2. Danh sách Services & Cổng

| Service | Port nội bộ | Port host | Database / Cache | Chức năng chính |
|---------|-------------|-----------|------------------|-----------------|
| **Nginx** | 80 | `8088` | - | Reverse proxy, cân bằng tải, log tracking upstream |
| **API Gateway** | 3000 | `3000` (internal) | - | Single entrypoint, xác thực JWT, phân quyền RBAC, rate limit |
| **Auth Service** | 3002 | `3002` (internal) | MongoDB (`Auth`) | Đăng ký, đăng nhập, cấp JWT token |
| **Product Service** | 3001 | `3001` (internal) | MongoDB (`product`), Redis | Quản lý sản phẩm, Cache-Aside pattern |
| **Inventory Service** | 3003 | `3003` (internal) | MongoDB (`Inventory`) | Quản lý tồn kho, trừ kho atomic (`$inc`), bulk sync SP |
| **Order Service** | 3004 | `3004` (internal) | MongoDB (`Order`) | Tạo đơn, sinh mã atomic (`ORD-YYYYMMDD-XXXX`), xử lý partial |
| **Redis** | 6379 | `6379` | In-memory | Cache thông tin chi tiết sản phẩm (TTL 60s) |

---

## 3. Yêu cầu cài đặt

- [Docker](https://www.docker.com/) & Docker Compose
- Node.js >= 18 (nếu muốn debug từng service trực tiếp trên máy host)
- MongoDB (nếu chạy local không qua Docker)

---

## 4. Cấu hình môi trường

Tạo file `.env` tại thư mục gốc từ mẫu `.env.example`:

```bash
cp .env.example .env
```

Nội dung mẫu `.env`:

```env
# Gateway
GATEWAY_PORT=3000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Auth & JWT
JWT_SECRET=supermarket-secret-key-change-in-production
JWT_EXPIRES_IN=24h

# Service Ports & Databases
PRODUCT_SERVICE_PORT=3001
MONGO_URI_AUTH=mongodb://localhost:27017/Auth
MONGO_URI_PRODUCTION=mongodb://localhost:27017/product
MONGO_URI_INVENTORY=mongodb://localhost:27017/Inventory
MONGO_URI_ORDER=mongodb://localhost:27017/Order

# Redis Cache
REDIS_URL=redis://redis:6379
REDIS_PRODUCT_TTL=60

# General
NODE_ENV=development
```

---

## 5. Khởi chạy hệ thống

### Khởi chạy bằng Docker Compose (Khuyến nghị)

```bash
# Build & chạy tất cả containers dưới nền
docker compose up -d --build

# Kiểm tra log
docker compose logs -f

# Dừng hệ thống
docker compose down
```

### Scale Gateway / Service (Cân bằng tải Nginx)

```bash
docker compose up -d --scale api-gateway=2 --scale product-service=2
```

---

## 6. Danh sách API Endpoints

Mọi request từ client gửi qua Nginx: `http://localhost:8088` (hoặc trực tiếp qua API Gateway `http://localhost:3000` nếu expose).

### 6.1. Health Check

| Method | Endpoint | Quyền | Mô tả |
|--------|----------|-------|-------|
| `GET` | `/health` | Public | Kiểm tra trạng thái API Gateway & instance hostname |
| `GET` | `/api/products/test-db` | Public | Kiểm tra kết nối MongoDB của Product Service |

---

### 6.2. Auth Service (`/api/auth`)

| Method | Endpoint | Quyền | Body / Query | Mô tả |
|--------|----------|-------|--------------|-------|
| `POST` | `/api/auth/register` | Public | `{ username, email, password, role }` | Đăng ký (`role`: `ADMIN` hoặc `STAFF`, mặc định `STAFF`) |
| `POST` | `/api/auth/login` | Public | `{ email, password }` | Đăng nhập, trả về JWT token |
| `GET` | `/api/auth/me` | Bearer Token | Header: `Authorization: Bearer <token>` | Lấy thông tin user hiện tại |

---

### 6.3. Product Service (`/api/products`)

Header yêu cầu: `Authorization: Bearer <token>`

| Method | Endpoint | Quyền | Mô tả |
|--------|----------|-------|-------|
| `GET` | `/api/products` | ADMIN / STAFF | Lấy danh sách sản phẩm |
| `GET` | `/api/products/:id` | ADMIN / STAFF | Lấy chi tiết sản phẩm (Cache-Aside qua Redis) |
| `POST` | `/api/products` | ADMIN / STAFF | Tạo sản phẩm mới (`name`, `price`, `quantity`) |
| `DELETE` | `/api/products/:id` | **ADMIN** | Xóa sản phẩm, xóa cache Redis tương ứng |
| `POST` | `/api/products/bulk` | Internal | Tra cứu danh sách sản phẩm theo mảng ID |

---

### 6.4. Inventory Service (`/api/inventory`)

Header yêu cầu: `Authorization: Bearer <token>`

| Method | Endpoint | Quyền | Mô tả |
|--------|----------|-------|-------|
| `GET` | `/api/inventory` | ADMIN / STAFF | Lấy danh sách tồn kho (kèm thông tin chi tiết từ Product Service) |
| `GET` | `/api/inventory/:productId` | ADMIN / STAFF | Chi tiết tồn kho theo ID sản phẩm |
| `POST` | `/api/inventory` | ADMIN / STAFF | Khởi tạo bản ghi tồn kho (`productId`, `quantity`) |
| `PATCH` | `/api/inventory/:productId` | **ADMIN** | Cập nhật số lượng tồn kho |
| `PATCH` | `/api/inventory/:productId/decrease` | ADMIN / STAFF | Trừ tồn kho atomic (`{ quantity }`), check `$gte` |

---

### 6.5. Order Service (`/api/orders`)

Header yêu cầu: `Authorization: Bearer <token>` (ADMIN hoặc STAFF)

| Method | Endpoint | Quyền | Mô tả |
|--------|----------|-------|-------|
| `GET` | `/api/orders` | ADMIN / STAFF | Lấy danh sách đơn hàng |
| `GET` | `/api/orders/:id` | ADMIN / STAFF | Chi tiết đơn hàng theo ID |
| `POST` | `/api/orders` | ADMIN / STAFF | Tạo đơn hàng mới |

**Body mẫu tạo đơn hàng:**
```json
{
  "items": [
    {
      "productId": "660c1d2e3f4a5b6c7d8e9f01",
      "quantity": 2
    }
  ]
}
```

**Đặc điểm xử lý đơn:**
- Kiểm tra thông tin giá từ `Product Service`.
- Gọi `Inventory Service` trừ kho atomic.
- Sinh mã đơn tự động theo ngày: `ORD-YYYYMMDD-0001` (dùng collection `Counter`).
- Hỗ trợ trạng thái đơn: `COMPLETED` (tất cả hợp lệ) hoặc `PARTIAL` (chứa item lỗi kèm `failedItems`).

---

## 7. Cấu trúc thư mục

```
supermarket-backend/
├── api-gateway/            # API Gateway: proxy, auth, rate limit, load balancer
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── app.js
│       ├── middleware/     # authenticate, authorize, rateLimiter
│       └── utils/          # loadBalancer
├── services/
│   ├── auth-service/       # Quản lý tài khoản, mật khẩu (bcrypt), JWT
│   ├── product-service/    # Quản lý sản phẩm, Redis caching
│   ├── inventory-service/  # Quản lý kho hàng, giao tiếp Product Service
│   └── order-service/      # Quản lý đơn hàng, điều phối Product & Inventory
├── nginx/                  # Nginx configuration (reverse proxy & access logging)
│   └── nginx.conf
├── tests/                  # Test payloads
├── .env.example            # Biến môi trường mẫu
├── .gitignore              # Git ignore rules
├── docker-compose.yml      # Docker orchestration
└── README.md
```
