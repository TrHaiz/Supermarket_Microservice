import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '1m', target: 200 },    // Ramp-up lên 200 VUs trong 1 phút
    { duration: '4m', target: 200 },    // Duy trì tải đỉnh 200 VUs trong 4 phút
    { duration: '1m', target: 0 },      // Ramp-down hạ về 0 trong 1 phút
  ],
  thresholds: {
    ...defaultStreamThresholds,
    'http_req_failed': ['rate<0.02'],              // Tối đa 2% lỗi dưới tải 200 VUs
    'http_req_duration': ['p(95)<1500'],          // p95 HTTP < 1.5s
    'order_create_duration': ['p(95)<1000'],       // Nhận đơn async < 1s
    'order_async_processing_time': ['p(95)<4000'], // Redis Stream hoàn tất p95 < 4s
  },
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

