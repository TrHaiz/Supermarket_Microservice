# Supermarket Backend

Backend quản lý siêu thị mini theo kiến trúc microservices, sử dụng Node.js, Express, MongoDB, Redis, Docker Compose và Nginx. Hệ thống gồm API Gateway và bốn service: Auth, Product, Inventory, Order; hỗ trợ tạo đơn đồng bộ qua REST hoặc bất đồng bộ qua Redis Streams.

## 1. Kiến trúc

```text
Client
  |
  v
Nginx :8088 (host) -> API Gateway :3000
                      | JWT, RBAC, rate limit, Docker DNS / round-robin
                      +-- Auth Service      :3002 -> MongoDB (tài khoản)
                      +-- Product Service   :3001 -> MongoDB (sản phẩm)
                      |                          -> Redis (cache chi tiết sản phẩm)
                      +-- Inventory Service :3003 -> MongoDB (tồn kho)
                      +-- Order Service     :3004 -> MongoDB (đơn hàng, counter)

Luồng đồng bộ:
Order -> Product (lấy giá) -> Inventory (trừ kho atomic) -> lưu đơn

Luồng bất đồng bộ:
Order -> lưu PENDING + outbox -> orders_stream
                                 |
                                 v
                           Inventory worker -> Product (lấy giá)
                                 |          -> trừ kho atomic, lưu receipt
                                 v
                        inventory_results_stream
                                 |
                                 v
                           Order worker -> cập nhật kết quả đơn
```

Các service dùng chung một MongoDB server trong Compose, với URI database riêng. Redis dùng chung cho cache sản phẩm và luồng sự kiện; Compose bật AOF, lưu vào volume và dùng chính sách `noeviction`.

### Service, cổng và số replica

| Thành phần | Cổng container | Cổng publish ra host | Replica mặc định | Vai trò |
|---|---|---|---|---|
| Nginx | 80 | `8088` | 1 | Reverse proxy tới Gateway, ghi log upstream |
| API Gateway | 3000 | Không publish | 3 | Xác thực JWT, phân quyền, rate limit, proxy |
| Auth Service | 3002 | Không publish | 3 | Đăng ký, đăng nhập, thông tin tài khoản |
| Product Service | 3001 | Không publish | 3 | Sản phẩm, cache-aside Redis |
| Inventory Service | 3003 | Không publish | 4 | Tồn kho, tổng hợp thông tin sản phẩm, worker trừ kho |
| Order Service | 3004 | Không publish | 5 | Đơn hàng, mã đơn theo ngày, outbox và worker kết quả |
| MongoDB | 27017 | `27017` | 1 | Lưu dữ liệu các service |
| Redis | 6379 | `6379` | 1 | Cache và Redis Streams |

Client truy cập tại `http://localhost:8088`. Các cổng `3000`–`3004` chỉ được `expose` trong mạng Docker; mặc định không truy cập trực tiếp từ host.

## 2. Cài đặt và khởi chạy

Cần Docker Engine/Docker Desktop và Docker Compose. Các Dockerfile dùng `node:20-alpine`; khi chạy code hoặc unit test trên host, có thể dùng Node.js 20 để đồng nhất với container. k6 chỉ cần khi chạy kiểm thử tải.

### Cấu hình môi trường

Tạo `.env` tại thư mục gốc từ [.env.example](.env.example):

```powershell
Copy-Item .env.example .env
```

Với Bash, dùng `cp .env.example .env`. Nếu đã có `.env`, chỉnh file hiện có.

**Trước khi chạy Docker, sửa cả bốn MongoDB URI.** File mẫu hiện có URI Auth/Product dùng `localhost`; trong container cần dùng hostname `mongodb` và tài khoản khởi tạo trong Compose. Ví dụ cho cấu hình Compose hiện tại:

```dotenv
MONGO_URI_AUTH=mongodb://admin:secret@mongodb:27017/Auth?authSource=admin
MONGO_URI_PRODUCTION=mongodb://admin:secret@mongodb:27017/product?authSource=admin
MONGO_URI_INVENTORY=mongodb://admin:secret@mongodb:27017/inventory_db?authSource=admin
MONGO_URI_ORDER=mongodb://admin:secret@mongodb:27017/order_db?authSource=admin

JWT_SECRET=replace-with-your-own-secret
JWT_EXPIRES_IN=24h

REDIS_URL=redis://redis:6379
REDIS_PRODUCT_TTL=60
ENABLE_ASYNC_ORDER=false

RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
PRODUCT_SERVICE_PORT=3001
INVENTORY_SERVICE_PORT=3003
DISCOVERY_TTL_MS=5000
STREAM_BATCH_SIZE=20
OUTBOX_BATCH_LIMIT=200
OUTBOX_POLL_INTERVAL_MS=200
NODE_ENV=development
```

`admin:secret` là thông tin khởi tạo MongoDB trong `docker-compose.yml`; volume MongoDB đã tồn tại sẽ giữ tài khoản cũ. `JWT_SECRET` phải giống nhau ở Auth và Gateway.

| Biến | Ý nghĩa trong code/cấu hình hiện tại |
|---|---|
| `MONGO_URI_AUTH` | URI được Auth Service đọc trực tiếp |
| `MONGO_URI_PRODUCTION` | URI được Product Service đọc trực tiếp; giữ nguyên tên `PRODUCTION` theo code |
| `MONGO_URI_INVENTORY`, `MONGO_URI_ORDER` | URI được Inventory/Order đọc trực tiếp |
| `JWT_EXPIRES_IN` | Thời hạn JWT, mặc định `24h` |
| `REDIS_PRODUCT_TTL` | TTL cache `product:<id>`, mặc định 60 giây |
| `ENABLE_ASYNC_ORDER` | Chỉ chuỗi `true` bật luồng bất đồng bộ và worker ở cả Order/Inventory; mặc định `false` |
| `STREAM_BATCH_SIZE` | Số message mỗi batch worker đọc, mặc định 20 |
| `OUTBOX_BATCH_LIMIT` | Số đơn chưa publish lấy mỗi lượt dispatcher, mặc định 200 |
| `OUTBOX_POLL_INTERVAL_MS` | Khoảng nghỉ giữa các lượt outbox, mặc định 200 ms |
| `DISCOVERY_TTL_MS` | TTL cache Docker DNS trong bộ cân bằng tải, mặc định 5.000 ms |
| `PRODUCT_SERVICE_PORT`, `INVENTORY_SERVICE_PORT` | Cổng cho HTTP client nội bộ; Compose vẫn cố định cổng lắng nghe của service |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` | Cửa sổ và số request tối đa theo IP tại từng Gateway; Compose mặc định 60.000 ms / 100 request |
| `PORT` | Cổng lắng nghe của từng tiến trình; Compose cố định theo bảng service |

Auth/Product nhận `.env` qua `env_file`; Inventory, Order và Gateway nhận các biến được liệt kê trong `environment` của Compose. Biến `GATEWAY_PORT` trong file mẫu chưa được Compose/code dùng để đổi cổng Gateway. Dù Compose có truyền thêm `MONGO_URI`, Auth/Product thực tế đọc hai biến URI riêng ở trên.

Rate limiter dùng bộ nhớ của từng Gateway, không dùng Redis làm bộ đếm chung. Nếu chạy Gateway trực tiếp mà không đặt `RATE_LIMIT_MAX_REQUESTS`, code hiện mặc định **100.000**, khác giá trị mặc định **100** trong Compose. `/health` của Gateway nằm trước rate limiter.

### Chạy bằng Docker Compose

Chạy các lệnh từ thư mục gốc repository:

```powershell
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f
```

Kiểm tra Gateway:

```powershell
Invoke-RestMethod http://localhost:8088/health
```

Scale các service khi cần:

```powershell
docker compose up -d --scale api-gateway=2 --scale product-service=2 --scale inventory-service=2 --scale order-service=2
```

Gateway và các HTTP client nội bộ chọn instance qua Docker DNS và round-robin. Nginx phân giải lại hostname Gateway qua Docker DNS. Header `X-Gateway-Instance`, `X-Handled-By-Upstream` và log Nginx giúp xác định instance xử lý request.

```powershell
docker compose logs -f order-service inventory-service
docker compose down
```

`docker compose down` giữ lại volume `mongo_data` và `redis_data`.

### Chạy riêng service trên host

Mỗi thư mục service có script `npm start` và `npm run dev` (`node --watch`). Root `package.json` hiện là `{}`, chưa có workspace hay script chạy toàn bộ hệ thống.

Ví dụ chạy Product Service bằng Node.js 20, từ thư mục gốc, với MongoDB/Redis đang chạy:

```powershell
npm --prefix services/product-service install
$env:MONGO_URI_PRODUCTION = 'mongodb://admin:secret@localhost:27017/product?authSource=admin'
$env:REDIS_URL = 'redis://localhost:6379'
$env:PORT = '3001'
node --watch services/product-service/src/app.js
```

Các tiến trình không tự nạp `.env`; cần truyền biến môi trường hoặc dùng tùy chọn `node --env-file=.env` với Node hỗ trợ tùy chọn này. URI trên host dùng `localhost` và thông tin xác thực phù hợp với MongoDB đang chạy.

Luồng liên service hiện phụ thuộc hostname Docker cố định (`product-service`, `inventory-service`, ...). Chỉ đổi các biến `*_SERVICE_URL` sang `localhost` chưa đủ để chạy toàn bộ hệ thống trên host vì router/load balancer vẫn chọn hostname service. Dùng Compose cho luồng tích hợp đầy đủ.

## 3. API

Base URL: `http://localhost:8088`.

Các quyền trong bảng dưới áp dụng khi đi qua Gateway. Ngoại trừ đăng ký, đăng nhập và `/health`, gửi header:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Gateway kiểm tra JWT và ghi đè `X-User-Id`, `X-User-Role` trước khi proxy. Product/Inventory/Order không tự xác thực JWT; các lệnh REST nội bộ gọi thẳng service trong mạng Docker.

### Health check

| Method | Endpoint | Quyền | Ý nghĩa |
|---|---|---|---|
| GET | `/health` | Public | Trạng thái tiến trình Gateway, hostname và timestamp |
| GET | `/api/products/test-db` | ADMIN / STAFF | Trạng thái kết nối MongoDB của Product |

Cả bốn service cũng có `GET /health` trên cổng nội bộ riêng. Gateway không proxy endpoint health riêng cho từng service; `/health` không kiểm tra readiness của toàn bộ hệ thống.

### Auth — `/api/auth`

| Method | Endpoint | Quyền | Body / kết quả |
|---|---|---|---|
| POST | `/api/auth/register` | Public | `{ username, email, password, role }`; trả `201`, `data.user`, `data.token` |
| POST | `/api/auth/login` | Public | `{ email, password }`; trả `200`, `data.user`, `data.token` |
| GET | `/api/auth/me` | Bearer token | Trả thông tin user hiện tại trong `data` |

Đăng ký yêu cầu username tối thiểu 3 ký tự, email chứa `@`, password tối thiểu 6 ký tự. `role` nhận `ADMIN` hoặc `STAFF`, mặc định `STAFF`. API đăng ký hiện cho phép client truyền cả `ADMIN`. Mật khẩu được hash bằng bcrypt; JWT mặc định có thời hạn 24 giờ.

### Product — `/api/products`

| Method | Endpoint | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/products?page=1&limit=20` | ADMIN / STAFF | Danh sách mới nhất trước; `limit` tối đa 100 |
| GET | `/api/products/:id` | ADMIN / STAFF | Chi tiết; cache-aside Redis với key `product:<id>` |
| POST | `/api/products` | ADMIN / STAFF | Tạo sản phẩm: `{ name, price, quantity }` |
| POST | `/api/products/bulk` | ADMIN / STAFF | `{ "ids": ["<productId>"] }`; cũng được Inventory gọi trực tiếp qua mạng nội bộ |
| DELETE | `/api/products/:id` | ADMIN | Xóa sản phẩm và cache tương ứng |

`name` là chuỗi không rỗng, `price` là số lớn hơn 0, `quantity` là số nguyên không âm. Bulk bỏ qua ID không hợp lệ/không tồn tại. Khi Redis cache lỗi, Product vẫn truy vấn MongoDB.

**Tồn kho phục vụ bán hàng nằm ở Inventory Service.** Tạo sản phẩm có trường `quantity` không tự tạo bản ghi Inventory; luồng bán hàng không tự cập nhật `Product.quantity`. Xóa sản phẩm cũng không tự xóa tồn kho hay đơn hàng liên quan.

### Inventory — `/api/inventory`

| Method | Endpoint | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/inventory` | ADMIN / STAFF | Toàn bộ tồn kho, ghép thông tin sản phẩm bằng bulk lookup |
| GET | `/api/inventory/:productId` | ADMIN / STAFF | Chi tiết gồm `product` và `inventory` |
| POST | `/api/inventory` | ADMIN / STAFF | Tạo tồn kho: `{ productId, quantity }`; kiểm tra sản phẩm tồn tại |
| PATCH | `/api/inventory/:productId` | ADMIN | Đặt lại số lượng: `{ quantity }` |
| PATCH | `/api/inventory/:productId/decrease` | ADMIN | Trừ kho atomic: `{ quantity }`; kiểm tra đủ kho bằng `$gte`, cập nhật bằng `$inc` |

Tạo/cập nhật tồn kho yêu cầu số nguyên `quantity >= 0`; trừ kho yêu cầu số nguyên `quantity > 0`. Mỗi `productId` chỉ có một bản ghi tồn kho; tạo trùng trả `409`. Gateway yêu cầu ADMIN cho **mọi PATCH**, bao gồm `/decrease`; Order gọi trừ kho trực tiếp trong mạng nội bộ nên STAFF vẫn có thể tạo đơn qua Gateway.

### Order — `/api/orders`

| Method | Endpoint | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/orders?page=1&limit=20` | ADMIN / STAFF | Danh sách mới nhất trước; `limit` tối đa 100 |
| GET | `/api/orders/:id` | ADMIN / STAFF | Chi tiết đơn; dùng để polling khi xử lý bất đồng bộ |
| POST | `/api/orders` | ADMIN / STAFF | Tạo đơn theo chế độ `ENABLE_ASYNC_ORDER` |

Body tạo đơn:

```json
{
  "items": [
    { "productId": "660c1d2e3f4a5b6c7d8e9f01", "quantity": 2 }
  ]
}
```

`items` phải là mảng không rỗng; mỗi item có `productId` là chuỗi không rỗng và `quantity` là số nguyên an toàn lớn hơn 0. Giá lấy từ Product Service. Mã đơn có dạng `ORD-YYYYMMDD-0001`, dùng counter MongoDB atomic theo ngày **UTC**.

Danh sách Product/Order trả `{ success, count, data }`; `count` là số bản ghi của trang hiện tại, không phải tổng số bản ghi.

## 4. Hai chế độ xử lý đơn hàng

### Đồng bộ — `ENABLE_ASYNC_ORDER=false` (mặc định)

Order xử lý lần lượt từng item: lấy giá sản phẩm, gọi Inventory trừ kho, rồi lưu đơn nếu có ít nhất một item thành công.

- `201 COMPLETED`: tất cả item thành công.
- `201 PARTIAL`: có item thành công và item lỗi; lỗi nằm trong `failedItems`.
- `400 ALL_ITEMS_FAILED`: tất cả item lỗi, không lưu đơn.

`items` trong đơn đã lưu chỉ chứa các dòng thành công, với `price`, `subtotal`; `total` là tổng các dòng này. Luồng hiện không có transaction/rollback xuyên service nếu lưu đơn thất bại sau khi đã trừ kho.

### Bất đồng bộ — `ENABLE_ASYNC_ORDER=true`

Đặt cờ trong `.env`, sau đó cập nhật cả Order và Inventory:

```powershell
docker compose up -d --build order-service inventory-service
```

1. Order lưu đơn `PENDING` và outbox ngay trong document MongoDB, rồi publish một event `order_created` cho mỗi dòng vào `orders_stream`.
2. Inventory worker thuộc `inventory_group` lấy giá, trừ kho atomic và lưu receipt theo `eventId = <orderId>:<itemIndex>` để xử lý lại không trừ kho lần nữa.
3. Worker phát `inventory_reserved` hoặc `inventory_failed` vào `inventory_results_stream` và ACK event đầu vào bằng Lua.
4. Order worker thuộc `order_group` ghi kết quả từng dòng, rồi chốt `COMPLETED`, `PARTIAL` hoặc `FAILED`. Client polling `GET /api/orders/:id` để lấy kết quả cuối.

| Tình huống | HTTP / trạng thái |
|---|---|
| Lưu và publish được yêu cầu | `202`, `data.orderId` / `data._id`, `data.status = PENDING` |
| Đã lưu đơn nhưng publish lỗi | `503 ORDER_PUBLISH_PENDING`, vẫn có `data.orderId` và `PENDING`; outbox sẽ thử lại |
| Mọi dòng thành công | Đơn chuyển sang `COMPLETED` |
| Một phần thành công | Đơn chuyển sang `PARTIAL`, có `failedItems` |
| Mọi dòng thất bại | Đơn chuyển sang `FAILED`, `items = []`, `total = 0` |

Dispatcher quét các đơn chưa publish; Redis hash chống publish trùng theo event ID. Consumer dùng kết nối riêng cho blocking read, ACK sau xử lý và `XAUTOCLAIM` để nhận lại message pending sau ít nhất 60 giây. Lỗi tạm thời từ Product/MongoDB được giữ pending để thử lại. Worker chạy trong từng tiến trình Order/Inventory và dừng cùng service khi nhận SIGTERM/SIGINT.

Khi nhận `503 ORDER_PUBLISH_PENDING`, tra cứu `orderId` đã trả về trước khi gửi lại yêu cầu tạo đơn; API hiện chưa có idempotency key cho các lần POST khác nhau. Chế độ async không tự chuyển sang REST khi Redis lỗi.

Để quay lại đồng bộ, chờ đơn async đang xử lý hoàn tất, đặt `ENABLE_ASYNC_ORDER=false` rồi cập nhật lại cả hai service bằng lệnh trên. Tắt cờ sẽ dừng worker; đơn `PENDING` còn lại cần worker được bật lại để tiếp tục. Stream, hash chống trùng và receipt trong Inventory hiện chưa có cơ chế tự dọn/trim trong code.

## 5. Thử luồng API bằng PowerShell

Sau khi hệ thống chạy, ví dụ dưới đây đăng ký tài khoản, tạo sản phẩm, khởi tạo kho và đặt đơn. Chạy từ terminal trên host:

```powershell
$baseUrl = 'http://localhost:8088'
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$registerBody = @{
  username = "demo_$suffix"
  email = "demo_$suffix@example.com"
  password = 'Password@123'
  role = 'STAFF'
} | ConvertTo-Json
$auth = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/auth/register" -ContentType 'application/json' -Body $registerBody
$headers = @{ Authorization = "Bearer $($auth.data.token)" }

$productBody = @{ name = 'Sua tuoi'; price = 25000; quantity = 100 } | ConvertTo-Json
$product = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/products" -Headers $headers -ContentType 'application/json' -Body $productBody
$productId = $product.data._id

$inventoryBody = @{ productId = $productId; quantity = 50 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$baseUrl/api/inventory" -Headers $headers -ContentType 'application/json' -Body $inventoryBody

$orderBody = @{ items = @(@{ productId = $productId; quantity = 2 }) } | ConvertTo-Json -Depth 5
$order = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/orders" -Headers $headers -ContentType 'application/json' -Body $orderBody
$orderId = $order.data._id
Invoke-RestMethod -Uri "$baseUrl/api/orders/$orderId" -Headers $headers
```

Nếu bật async, lặp lại GET chi tiết đến khi `data.status` khác `PENDING`. Luồng thành công có tổng tiền `50000` và tồn kho Inventory còn `48`.

## 6. Kiểm thử

### Unit test

Order và Inventory có script `npm test`, dùng test runner tích hợp của Node.js. Từ thư mục gốc:

```powershell
npm --prefix services/order-service ci
npm --prefix services/inventory-service ci
npm --prefix services/order-service test
npm --prefix services/inventory-service test
```

Các test dùng mock cho MongoDB/Redis/HTTP, kiểm tra outbox, phản hồi async/sync, xử lý sự kiện trùng hoặc sai thứ tự, phục hồi consumer, chống trừ kho lặp và chống bán vượt tồn trong mô hình mock. Đây chưa phải kiểm thử tích hợp với MongoDB/Redis thật. Auth, Product và Gateway hiện chưa có script `test`.

Thư mục `tests/` và `test-product.json` chứa payload JSON mẫu cho API sản phẩm.

### Kiểm thử tải bằng k6

Các script mặc định gửi request tới `http://localhost:8088`, có thể đổi bằng `-e BASE_URL=...`.

| Chế độ | Nhóm script |
|---|---|
| Đồng bộ (`ENABLE_ASYNC_ORDER=false`) | `smoke-test.js`, `load-10-vus.js`, `load-25-vus.js`, `load-50-vus.js`, `load-100-vus.js`, `stress-test.js`, `soak-test.js` |
| Redis Streams (`ENABLE_ASYNC_ORDER=true`) | `redis-stream-smoke-test.js`, `redis-stream-load-10vu.js`, `redis-stream-load-25vu.js`, `redis-stream-load-50vu.js`, `redis-stream-load-100vu.js`, `redis-stream-stress-test.js`, `redis-stream-soak-test.js`, `test-redis-stream-10vu.js` |

```powershell
# Chạy khi cờ async đang false
k6 run k6/smoke-test.js

# Chạy sau khi bật async và cập nhật Order/Inventory
k6 run -e BASE_URL=http://localhost:8088 k6/redis-stream-smoke-test.js
```

Các bài test tạo dữ liệu thật trong database. Nhóm lifecycle kiểm tra đăng ký/đăng nhập, sản phẩm, kho, đơn hàng; nhóm stream có polling tồn kho và trạng thái đơn. Khi đo tải, đặt `RATE_LIMIT_MAX_REQUESTS` phù hợp trong `.env` và cập nhật Gateway bằng `docker compose up -d api-gateway` để tránh kết quả bị chi phối bởi HTTP `429`.

## 7. Cấu trúc thư mục

```text
supermarket-backend/
├── api-gateway/
│   └── src/
│       ├── app.js
│       ├── middleware/          # JWT, RBAC, rate limiter
│       └── utils/               # Docker DNS / round-robin
├── services/
│   ├── auth-service/src/        # Routes, User, cấu hình database
│   ├── product-service/src/     # Routes, Product, validation, Redis cache
│   ├── inventory-service/
│   │   ├── src/                 # Routes, clients, models, config, workers
│   │   └── test/                # Unit test inventory worker
│   └── order-service/
│       ├── src/                 # Routes, controller, clients, models, config, workers
│       └── test/                # Unit test đơn hàng và consumer Streams
├── nginx/nginx.conf             # Reverse proxy, Docker DNS, log upstream
├── k6/                          # Kịch bản tải đồng bộ và Redis Streams
├── tests/                       # Payload JSON mẫu cho Product
├── test-product.json
├── .env.example
├── docker-compose.yml
├── package.json                 # Chưa khai báo script/workspace
└── README.md
```
