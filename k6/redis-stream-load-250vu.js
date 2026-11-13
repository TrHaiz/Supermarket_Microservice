import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '1m30s', target: 250 }, // Ramp-up lên 250 VUs trong 1.5 phút
    { duration: '4m', target: 250 },    // Duy trì tải đỉnh 250 VUs trong 4 phút
    { duration: '1m', target: 0 },      // Ramp-down hạ về 0 trong 1 phút
  ],
  thresholds: {
    ...defaultStreamThresholds,
    'http_req_failed': ['rate<0.03'],              // Tối đa 3% lỗi dưới tải 250 VUs
    'http_req_duration': ['p(95)<2000'],          // p95 HTTP < 2s
    'order_create_duration': ['p(95)<1000'],       // Nhận đơn async < 1s
    'order_async_processing_time': ['p(95)<5000'], // Redis Stream hoàn tất p95 < 5s
  },
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

