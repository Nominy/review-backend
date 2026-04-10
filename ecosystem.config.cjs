module.exports = {
  apps: [
    {
      name: "babel-review-backend",
      script: "bun",
      args: "--no-env-file src/index.ts",
      interpreter: "none",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      time: true,
      merge_logs: true,
      out_file: "./logs/pm2/review-backend.out.log",
      error_file: "./logs/pm2/review-backend.error.log"
    }
  ]
};
