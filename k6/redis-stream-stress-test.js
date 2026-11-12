import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 100 },
    { duration: '1m30s', target: 150 },
    { duration: '30s', target: 150 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    ...defaultStreamThresholds,
    'http_req_failed': ['rate<0.05'], // Stress test chấp nhận tối đa 5% failure
    'order_async_processing_time': ['p(95)<5000'], // Khi quá tải 150 VUs, thời gian xử lý stream cho phép đến 5s
  },
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

