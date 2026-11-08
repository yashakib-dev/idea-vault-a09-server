import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "15s", target: 20 },
    { duration: "30s", target: 50 },
    { duration: "45s", target: 50 },
    { duration: "15s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<150", "p(99)<250"],
    http_req_failed: ["rate<0.01"],
  },
};

const BASE_URL = __ENV.TARGET_URL || "https://idea-vault-a09-server.vercel.app";

export default function () {
  const ideasRes = http.get(`${BASE_URL}/ideas`);
  check(ideasRes, {
    "featured ideas status is 200": (r) => r.status === 200,
    "featured ideas response time < 100ms": (r) => r.timings.duration < 100,
  });

  const searchRes = http.get(`${BASE_URL}/all-ideas?category=Tech`);
  check(searchRes, {
    "filtered search status is 200": (r) => r.status === 200,
    "filtered search response time < 120ms": (r) => r.timings.duration < 120,
  });

  const commentRes = http.get(`${BASE_URL}/comments/64f0dfc7d1144d3c1fef1234`);
  check(commentRes, {
    "comments status is 200": (r) => r.status === 200,
  });

  sleep(1);
}

