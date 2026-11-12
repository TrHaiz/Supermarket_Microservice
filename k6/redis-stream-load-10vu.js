import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '20s', target: 10 },
    { duration: '1m20s', target: 10 },
    { duration: '20s', target: 0 },
  ],
  thresholds: defaultStreamThresholds,
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

