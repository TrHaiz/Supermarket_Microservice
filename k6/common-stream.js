import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8088';

// Specific metrics separating each layer of the async system
export const authDuration = new Trend('auth_api_duration');
export const productDuration = new Trend('product_api_duration');
export const productCreateDuration = new Trend('product_create_duration');
export const productReadDuration = new Trend('product_read_duration');
export const inventoryDuration = new Trend('inventory_api_duration');

// Separated Order metrics
export const orderDuration = new Trend('order_api_duration');           // POST /api/orders (Async ingestion)
export const orderCreateDuration = new Trend('order_create_duration');   // POST /api/orders
export const orderListDuration = new Trend('order_list_duration');       // GET /api/orders?limit=20
export const orderDetailDuration = new Trend('order_detail_duration');   // GET /api/orders/:id

// Redis Stream processing metrics
export const orderAsyncProcessingTime = new Trend('order_async_processing_time'); // Total async latency: POST -> COMPLETED
export const inventoryAsyncSyncTime = new Trend('inventory_async_sync_time');     // Async inventory reduction latency
export const failureRate = new Rate('http_failure_rate');
export const asyncOrderSuccessRate = new Rate('async_order_success_rate');

export const defaultStreamThresholds = {
  'http_req_failed': ['rate<0.01'],              // HTTP error rate < 1%
  'checks': ['rate>0.99'],                       // Check pass rate > 99%
  'http_req_duration': ['p(95)<1000'],           // HTTP request p95 < 1s
  'auth_api_duration': ['p(95)<1000'],
  'product_api_duration': ['p(95)<500'],
  'inventory_api_duration': ['p(95)<500'],
  'order_create_duration': ['p(95)<500'],        // Async order creation ingestion < 500ms
  'order_list_duration': ['p(95)<500'],          // Paginated order list query < 500ms
  'order_api_duration': ['p(95)<500'],           // Core order API < 500ms
  'order_async_processing_time': ['p(95)<2500'], // Redis Stream async completion p95 < 2.5s
  'inventory_async_sync_time': ['p(95)<2000'],   // Redis Stream stock decrement p95 < 2.0s
  'async_order_success_rate': ['rate>0.99'],     // Stream order completed rate > 99%
};

export function runFullUserLifecycleStream() {
  const ts = Date.now();
  const randSuffix = Math.floor(Math.random() * 1000000);
  const username = `stream_u_${__VU}_${__ITER}_${randSuffix}`;
  const email = `${username}@supermarket.test`;
  const password = 'Password@123';

  const jsonHeaders = { 'Content-Type': 'application/json' };

  // 1. Đăng ký tài khoản (Auth Service)
  const regPayload = JSON.stringify({
    username: username,
    email: email,
    password: password,
    role: 'ADMIN',
  });

  const regRes = http.post(`${BASE_URL}/api/auth/register`, regPayload, {
    headers: jsonHeaders,
    tags: { name: 'POST /api/auth/register' },
  });
  authDuration.add(regRes.timings.duration);
  failureRate.add(regRes.status !== 201);
  const regOk = check(regRes, {
    'register status 201': (r) => r.status === 201,
  });

  if (!regOk) {
    console.error(`[Register Failed] ${regRes.status}: ${regRes.body}`);
    return;
  }

  // 2. Đăng nhập lấy JWT riêng (Auth Service)
  const loginPayload = JSON.stringify({
    email: email,
    password: password,
  });

  const loginRes = http.post(`${BASE_URL}/api/auth/login`, loginPayload, {
    headers: jsonHeaders,
    tags: { name: 'POST /api/auth/login' },
  });
  authDuration.add(loginRes.timings.duration);
  failureRate.add(loginRes.status !== 200);
  const loginOk = check(loginRes, {
    'login status 200': (r) => r.status === 200,
    'login returns token': (r) => r.json('data.token') !== undefined,
  });

  if (!loginOk) {
    console.error(`[Login Failed] ${loginRes.status}: ${loginRes.body}`);
    return;
  }

  const token = loginRes.json('data.token');
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // 3. GET /api/auth/me (Xác thực session Auth Service)
  const meRes = http.get(`${BASE_URL}/api/auth/me`, {
    headers: authHeaders,
    tags: { name: 'GET /api/auth/me' },
  });
  authDuration.add(meRes.timings.duration);
  failureRate.add(meRes.status !== 200);
  check(meRes, {
    'auth me status 200': (r) => r.status === 200,
  });

  // 4. Tạo sản phẩm mới (Product Service)
  const prodPayload = JSON.stringify({
    name: `Stream_Prod_${__VU}_${ts}_${randSuffix}`,
    price: 30000,
    quantity: 100,
  });

  const prodRes = http.post(`${BASE_URL}/api/products`, prodPayload, {
    headers: authHeaders,
    tags: { name: 'POST /api/products' },
  });
  productDuration.add(prodRes.timings.duration);
  productCreateDuration.add(prodRes.timings.duration);
  failureRate.add(prodRes.status !== 201);
  const prodOk = check(prodRes, {
    'create product status 201': (r) => r.status === 201,
  });

  if (!prodOk) {
    console.error(`[Create Product Failed] ${prodRes.status}: ${prodRes.body}`);
    return;
  }

  const productId = prodRes.json('data._id');

  // 5. Tạo kho hàng (Inventory Service)
  const invPayload = JSON.stringify({
    productId: productId,
    quantity: 50,
  });

  const invRes = http.post(`${BASE_URL}/api/inventory`, invPayload, {
    headers: authHeaders,
    tags: { name: 'POST /api/inventory' },
  });
  inventoryDuration.add(invRes.timings.duration);
  failureRate.add(invRes.status !== 201);
  const invOk = check(invRes, {
    'create inventory status 201': (r) => r.status === 201,
  });

  if (!invOk) {
    console.error(`[Create Inventory Failed] ${invRes.status}: ${invRes.body}`);
    return;
  }

  // 6. Tạo đơn hàng (Order Service - Bắn event vào Redis Stream)
  const orderPayload = JSON.stringify({
    items: [
      {
        productId: productId,
        quantity: 2,
      },
    ],
  });

  const orderStartTime = Date.now();
  const orderRes = http.post(`${BASE_URL}/api/orders`, orderPayload, {
    headers: authHeaders,
    tags: { name: 'POST /api/orders' },
  });
  orderDuration.add(orderRes.timings.duration);
  orderCreateDuration.add(orderRes.timings.duration);

  // Redis Stream Async API trả về 202 Accepted (hoặc 201 fallback)
  const isOrderAccepted = orderRes.status === 202 || orderRes.status === 201;
  failureRate.add(!isOrderAccepted);
  const orderOk = check(orderRes, {
    'create order status 202 or 201': (r) => r.status === 202 || r.status === 201,
  });

  let orderId = null;
  if (orderOk) {
    orderId = orderRes.json('data._id') || orderRes.json('data.orderId') || orderRes.json('orderId');
  }

  // 7. Get dữ liệu từ Product Service (có phân trang limit=20 và gán tags.name)
  // 7a. Get paginated products
  const listProdRes = http.get(`${BASE_URL}/api/products?limit=20`, {
    headers: authHeaders,
    tags: { name: 'GET /api/products' },
  });
  productDuration.add(listProdRes.timings.duration);
  productReadDuration.add(listProdRes.timings.duration);
  failureRate.add(listProdRes.status !== 200);
  check(listProdRes, {
    'get all products status 200': (r) => r.status === 200,
  });

  // 7b. Get product detail (Redis Cache-Aside, URL grouped tag)
  const getProdRes = http.get(`${BASE_URL}/api/products/${productId}`, {
    headers: authHeaders,
    tags: { name: 'GET /api/products/:id' },
  });
  productDuration.add(getProdRes.timings.duration);
  productReadDuration.add(getProdRes.timings.duration);
  failureRate.add(getProdRes.status !== 200);
  check(getProdRes, {
    'get product detail status 200': (r) => r.status === 200,
  });

  // 8. Polling xác thực tồn kho đã được trừ qua Redis Stream (50 - 2 = 48)
  let inventoryUpdated = false;
  const maxRetries = 25;
  const pollInterval = 0.15; // 150ms

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    sleep(pollInterval);
    const getInvRes = http.get(`${BASE_URL}/api/inventory/${productId}`, {
      headers: authHeaders,
      tags: { name: 'GET /api/inventory/:productId' },
    });
    if (getInvRes.status === 200) {
      const q = getInvRes.json('inventory.quantity') ?? getInvRes.json('data.quantity');
      if (q === 48) { // 50 ban đầu - 2 đã mua
        inventoryUpdated = true;
        inventoryDuration.add(getInvRes.timings.duration);
        inventoryAsyncSyncTime.add(Date.now() - orderStartTime);
        break;
      }
    }
  }

  failureRate.add(!inventoryUpdated);
  check(null, {
    'inventory reduced correctly via stream (50 - 2 = 48)': () => inventoryUpdated,
  });

  // 9. Get dữ liệu từ Order Service
  // 9a. Get paginated orders (limit=20, URL grouped tag)
  const listOrderRes = http.get(`${BASE_URL}/api/orders?limit=20`, {
    headers: authHeaders,
    tags: { name: 'GET /api/orders' },
  });
  orderListDuration.add(listOrderRes.timings.duration);
  failureRate.add(listOrderRes.status !== 200);
  check(listOrderRes, {
    'get all orders status 200': (r) => r.status === 200,
  });

  // 9b. Polling kiểm tra trạng thái đơn chuyển sang COMPLETED qua Redis Stream (URL grouped tag)
  if (orderId) {
    let orderCompleted = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      sleep(pollInterval);
      const getOrderRes = http.get(`${BASE_URL}/api/orders/${orderId}`, {
        headers: authHeaders,
        tags: { name: 'GET /api/orders/:id' },
      });
      if (getOrderRes.status === 200) {
        orderDetailDuration.add(getOrderRes.timings.duration);
        const status = getOrderRes.json('data.status') ?? getOrderRes.json('status');
        if (status === 'COMPLETED') {
          orderCompleted = true;
          orderAsyncProcessingTime.add(Date.now() - orderStartTime);
          break;
        }
      }
    }

    asyncOrderSuccessRate.add(orderCompleted);
    check(null, {
      'order status changed to COMPLETED via stream': () => orderCompleted,
    });
  }

  sleep(0.5); // Thời gian nghỉ giữa các iteration
}
