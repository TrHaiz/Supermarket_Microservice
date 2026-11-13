import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '1m', target: 100 },     // Khởi động 100 VUs
    { duration: '1m30s', target: 200 },  // Bậc 1: Tăng lên 200 VUs
    { duration: '1m30s', target: 250 },  // Bậc 2: Tăng lên 250 VUs
    { duration: '2m', target: 300 },     // Bậc 3: Tăng lên 300 VUs
    { duration: '1m', target: 300 },     // Giữ đỉnh 300 VUs
    { duration: '1m', target: 0 },       // Hạ tải về 0
  ],
  thresholds: {
    ...defaultStreamThresholds,
    'http_req_failed': ['rate<0.05'],              // Cho phép tối đa 5% failure khi stress
    'order_async_processing_time': ['p(95)<6000'], // Khi dồn tải 300 VUs, stream cho phép xử lý đến 6s
    'http_req_duration': ['p(95)<2500'],
  },
};

export default function () {
  runFullUserLifecycleStream();
  sleep(0.5); // Giảm sleep để tăng mật độ request ép tải tối đa
}

