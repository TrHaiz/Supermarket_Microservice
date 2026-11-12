import { sleep } from 'k6';
import { runFullUserLifecycle, defaultThresholds } from './common.js';

export const options = {
  vus: 2,
  duration: '1m',
  thresholds: defaultThresholds,
};

export default function () {
  runFullUserLifecycle();
  sleep(1);
}
