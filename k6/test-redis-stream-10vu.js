import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8088';

// Custom metrics
export const authDuration = new Trend('auth_api_duration');
export const productDuration = new Trend('product_api_duration');
export const inventoryDuration = new Trend('inventory_api_duration');
export const orderDuration = new Trend('order_api_duration');
export const failureRate = new Rate('http_failure_rate');

export const options = {
  vus: 10,
  duration: '30s', // Thay đổi thời gian chạy test tùy theo nhu cầu (ví dụ: 30s)
  thresholds: {
    'http_req_failed': ['rate<0.01'], // Failure rate < 1%
    'checks': ['rate>0.99'],          // Pass rate > 99%
    'http_req_duration': ['p(95)<1000'],
    'auth_api_duration': ['p(95)<1000'],
    'product_api_duration': ['p(95)<1000'],
    'inventory_api_duration': ['p(95)<1000'],
    'order_api_duration': ['p(95)<1000'],
  },
};

export default function () {
  const ts = Date.now();
  const randSuffix = Math.floor(Math.random() * 100000);
  const username = `u_${__VU}_${__ITER}_${randSuffix}`;
  const email = `${username}@supermarket.test`;
  const password = 'Password@123';

  const jsonHeaders = { 'Content-Type': 'application/json' };

  // 1. Đăng ký tài khoản (Register)
  const regPayload = JSON.stringify({
    username: username,
    email: email,
    password: password,
    role: 'ADMIN',
  });

  const regRes = http.post(`${BASE_URL}/api/auth/register`, regPayload, { headers: jsonHeaders });
  authDuration.add(regRes.timings.duration);
  failureRate.add(regRes.status !== 201);
  const regOk = check(regRes, {
    'register status 201': (r) => r.status === 201,
  });

  if (!regOk) {
    console.error(`Register failed: ${regRes.status} ${regRes.body}`);
    return;
  }

  // 2. Đăng nhập lấy JWT riêng cho user (Login)
  const loginPayload = JSON.stringify({
    email: email,
    password: password,
  });

  const loginRes = http.post(`${BASE_URL}/api/auth/login`, loginPayload, { headers: jsonHeaders });
  authDuration.add(loginRes.timings.duration);
  failureRate.add(loginRes.status !== 200);
  const loginOk = check(loginRes, {
    'login status 200': (r) => r.status === 200,
    'login returns token': (r) => r.json('data.token') !== undefined,
  });

  if (!loginOk) {
    console.error(`Login failed: ${loginRes.status} ${loginRes.body}`);
    return;
  }

  const token = loginRes.json('data.token');
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // 3. GET /api/auth/me (Auth Service check)
  const meRes = http.get(`${BASE_URL}/api/auth/me`, { headers: authHeaders });
  authDuration.add(meRes.timings.duration);
  failureRate.add(meRes.status !== 200);
  check(meRes, {
    'auth me status 200': (r) => r.status === 200,
  });

  // 4. Tạo sản phẩm mới (Product Service)
  const prodPayload = JSON.stringify({
    name: `Item_${__VU}_${ts}_${randSuffix}`,
    price: 25000,
    quantity: 100,
  });

  const prodRes = http.post(`${BASE_URL}/api/products`, prodPayload, { headers: authHeaders });
  productDuration.add(prodRes.timings.duration);
  failureRate.add(prodRes.status !== 201);
  const prodOk = check(prodRes, {
    'create product status 201': (r) => r.status === 201,
  });

  if (!prodOk) {
    console.error(`Create product failed: ${prodRes.status} ${prodRes.body}`);
    return;
  }

  const productId = prodRes.json('data._id');

  // 5. Tạo kho hàng cho sản phẩm vừa tạo (Inventory Service)
  const invPayload = JSON.stringify({
    productId: productId,
    quantity: 50,
  });

  const invRes = http.post(`${BASE_URL}/api/inventory`, invPayload, { headers: authHeaders });
  inventoryDuration.add(invRes.timings.duration);
  failureRate.add(invRes.status !== 201);
  const invOk = check(invRes, {
    'create inventory status 201': (r) => r.status === 201,
  });

  if (!invOk) {
    console.error(`Create inventory failed: ${invRes.status} ${invRes.body}`);
    return;
  }

  // 6. Tạo đơn hàng (Order Service - Asynchronous Redis Streams)
  const orderPayload = JSON.stringify({
    items: [
      {
        productId: productId,
        quantity: 2,
      },
    ],
  });

  const orderRes = http.post(`${BASE_URL}/api/orders`, orderPayload, { headers: authHeaders });
  orderDuration.add(orderRes.timings.duration);

  // Chấp nhận cả 201 Created lẫn 202 Accepted tùy theo thiết kế của Async API
  const isOrderAccepted = orderRes.status === 201 || orderRes.status === 202;
  failureRate.add(!isOrderAccepted);
  const orderOk = check(orderRes, {
    'create order status 201 or 202': (r) => r.status === 201 || r.status === 202,
  });

  let orderId = null;
  if (orderOk) {
    orderId = orderRes.json('data._id') || orderRes.json('orderId');
  }

  // 7. Get dữ liệu từ Product Service
  // 7a. Get all products
  const listProdRes = http.get(`${BASE_URL}/api/products`, { headers: authHeaders });
  productDuration.add(listProdRes.timings.duration);
  failureRate.add(listProdRes.status !== 200);
  check(listProdRes, {
    'get all products status 200': (r) => r.status === 200,
  });

  // 7b. Get product by ID (test Cache Aside)
  const getProdRes = http.get(`${BASE_URL}/api/products/${productId}`, {
    headers: authHeaders,
    tags: { name: 'GET /api/products/:id' },
  });
  productDuration.add(getProdRes.timings.duration);
  failureRate.add(getProdRes.status !== 200);
  check(getProdRes, {
    'get product detail status 200': (r) => r.status === 200,
  });

  // 8. Get dữ liệu từ Inventory Service (Polling retry chờ Redis Worker xử lý xong)
  let inventoryUpdated = false;
  const maxRetries = 10;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    sleep(0.1); // Ngủ 100ms chờ Worker xử lý XREADGROUP -> reserveInventory -> XACK
    const getInvRes = http.get(`${BASE_URL}/api/inventory/${productId}`, {
      headers: authHeaders,
      tags: { name: 'GET /api/inventory/:productId' },
    });
    if (getInvRes.status === 200) {
      const q = getInvRes.json('inventory.quantity') ?? getInvRes.json('data.quantity');
      if (q === 48) { // 50 ban đầu trừ 2
        inventoryUpdated = true;
        inventoryDuration.add(getInvRes.timings.duration);
        break;
      }
    }
  }

  failureRate.add(!inventoryUpdated);
  check(null, {
    'inventory reduced correctly (50 - 2 = 48)': () => inventoryUpdated,
  });

  // 9. Get dữ liệu từ Order Service
  // 9a. Get all orders
  const listOrderRes = http.get(`${BASE_URL}/api/orders?limit=20`, {
    headers: authHeaders,
    tags: { name: 'GET /api/orders' },
  });
  orderDuration.add(listOrderRes.timings.duration);
  failureRate.add(listOrderRes.status !== 200);
  check(listOrderRes, {
    'get all orders status 200': (r) => r.status === 200,
  });

  // 9b. Get order detail by ID (Polling retry chờ status chuyển sang COMPLETED)
  if (orderId) {
    let orderCompleted = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const getOrderRes = http.get(`${BASE_URL}/api/orders/${orderId}`, {
        headers: authHeaders,
        tags: { name: 'GET /api/orders/:id' },
      });
      if (getOrderRes.status === 200) {
        const status = getOrderRes.json('data.status') ?? getOrderRes.json('status');
        if (status === 'COMPLETED') {
          orderCompleted = true;
          orderDuration.add(getOrderRes.timings.duration);
          break;
        }
      }
      sleep(0.1);
    }

    check(null, {
      'get order detail status COMPLETED': () => orderCompleted,
    });
  }

  sleep(1); // Giữ khoảng nghỉ giữa các lần lặp của VU
}
