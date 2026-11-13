import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '2m', target: 300 },    // Ramp-up lên 300 VUs trong 2 phút
    { duration: '4m', target: 300 },    // Duy trì tải cực hạn 300 VUs trong 4 phút
    { duration: '1m', target: 0 },      // Ramp-down hạ về 0 trong 1 phút
  ],
  thresholds: {
    ...defaultStreamThresholds,
    'http_req_failed': ['rate<0.05'],              // Cho phép tối đa 5% lỗi ở mức cực tải 300 VUs
    'http_req_duration': ['p(95)<2500'],          // p95 HTTP < 2.5s
    'order_create_duration': ['p(95)<1500'],       // Nhận đơn async < 1.5s
    'order_async_processing_time': ['p(95)<6000'], // Redis Stream hoàn tất p95 < 6s
  },
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

