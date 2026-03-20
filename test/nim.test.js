// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const nim = require("../bin/lib/nim");

describe("nim", () => {
  describe("listModels", () => {
    it("returns the bundled local NIM catalog", () => {
      assert.equal(nim.listModels().length, 14);
    });

    it("each model has hardware metadata for selection", () => {
      for (const m of nim.listModels()) {
        assert.ok(m.name, "missing name");
        assert.ok(m.image, "missing image");
        assert.ok(typeof m.minGpuMemoryMB === "number", "minGpuMemoryMB should be number");
        assert.ok(m.minGpuMemoryMB > 0, "minGpuMemoryMB should be positive");
        assert.ok(typeof m.recommendedRank === "number", "recommendedRank should be number");
        assert.ok(Array.isArray(m.profiles), "profiles should be an array");
      }
    });
  });

  describe("getImageForModel", () => {
    it("returns correct image for known model", () => {
      assert.equal(
        nim.getImageForModel("nvidia/nemotron-3-nano-30b-a3b"),
        "nvcr.io/nim/nvidia/nemotron-3-nano:latest"
      );
    });

    it("returns null for unknown model", () => {
      assert.equal(nim.getImageForModel("bogus/model"), null);
    });
  });

  describe("getServedModelForModel", () => {
    it("maps aliased pull targets to the live API model id", () => {
      assert.equal(
        nim.getServedModelForModel("nvidia/nemotron-3-nano-30b-a3b"),
        "nvidia/nemotron-3-nano"
      );
      assert.equal(nim.getServedModelForModel("z-ai/glm5"), "zai-org/GLM-5");
    });

    it("returns the original model id when no alias is needed", () => {
      assert.equal(
        nim.getServedModelForModel("nvidia/nemotron-3-super-120b-a12b"),
        "nvidia/nemotron-3-super-120b-a12b"
      );
    });
  });

  describe("pullNimImage", () => {
    it("falls back to the legacy nano image when the official pull target is denied", () => {
      const runnerPath = path.join(__dirname, "..", "bin", "lib", "runner.js");
      const originalRun = require(runnerPath).run;
      const runner = require(runnerPath);
      const commands = [];
      runner.run = (command) => {
        commands.push(command);
        if (command.includes("nemotron-3-nano:latest")) {
          return { status: 1 };
        }
        return { status: 0 };
      };

      try {
        assert.equal(
          nim.pullNimImage("nvidia/nemotron-3-nano-30b-a3b"),
          "nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest"
        );
      } finally {
        runner.run = originalRun;
      }

      assert.deepEqual(commands, [
        "docker pull nvcr.io/nim/nvidia/nemotron-3-nano:latest",
        "docker pull nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest",
      ]);
    });
  });

  describe("containerName", () => {
    it("prefixes with nemoclaw-nim-", () => {
      assert.equal(nim.containerName("my-sandbox"), "nemoclaw-nim-my-sandbox");
    });
  });

  describe("detectGpu", () => {
    it("returns object or null", () => {
      const gpu = nim.detectGpu();
      if (gpu !== null) {
        assert.ok(gpu.type, "gpu should have type");
        assert.ok(typeof gpu.count === "number", "count should be number");
        assert.ok(typeof gpu.totalMemoryMB === "number", "totalMemoryMB should be number");
        assert.ok(typeof gpu.nimCapable === "boolean", "nimCapable should be boolean");
      }
    });

    it("nvidia type is nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "nvidia") {
        assert.equal(gpu.nimCapable, true);
      }
    });

    it("apple type is not nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "apple") {
        assert.equal(gpu.nimCapable, false);
        assert.ok(gpu.name, "apple gpu should have name");
      }
    });
  });

  describe("getCompatibleModels", () => {
    it("prefers the single-GPU nano profile on a 1x L40S class machine", () => {
      const models = nim.getCompatibleModels(
        {
          type: "nvidia",
          count: 1,
          totalMemoryMB: 46068,
          perGpuMB: 46068,
          family: "l40s",
          families: ["l40s"],
          freeDiskGB: 120,
          nimCapable: true,
        },
        120
      );

      assert.equal(models[0].name, "nvidia/nemotron-3-nano-30b-a3b");
    });

    it("selects larger multi-GPU models when the machine profile supports them", () => {
      const models = nim.getCompatibleModels(
        {
          type: "nvidia",
          count: 4,
          totalMemoryMB: 4 * 81920,
          perGpuMB: 81920,
          family: "h100",
          families: ["h100"],
          freeDiskGB: 200,
          nimCapable: true,
        },
        200
      );

      assert.deepEqual(
        models.map((model) => model.name),
        [
          "nvidia/nemotron-3-nano-30b-a3b",
          "nvidia/llama-3.3-nemotron-super-49b-v1.5",
          "qwen/qwen3-coder-next",
          "deepseek-ai/deepseek-r1-distill-qwen-32b",
          "qwen/qwen3.5-35b-a3b",
          "qwen/qwen3.5-122b-a10b",
        ]
      );
    });
  });

  describe("assessNimModels", () => {
    it("marks compatible models as recommended or supported and explains exclusions", () => {
      const assessments = nim.assessNimModels(
        {
          type: "nvidia",
          count: 1,
          totalMemoryMB: 46068,
          perGpuMB: 46068,
          family: "l40s",
          families: ["l40s"],
          freeDiskGB: 120,
          nimCapable: true,
        },
        120
      );

      assert.equal(assessments[0].model.name, "nvidia/nemotron-3-nano-30b-a3b");
      assert.equal(assessments[0].status, "recommended");
      assert.match(assessments[0].reason, /Recommended on l40s/);
      assert.match(
        assessments.find((assessment) => assessment.model.name === "openai/gpt-oss-20b").reason,
        /published support/
      );
    });
  });

  describe("resolveRunningNimModel", () => {
    it("prefers the served id exposed by the running container", () => {
      const runnerPath = path.join(__dirname, "..", "bin", "lib", "runner.js");
      const runner = require(runnerPath);
      const originalRunCapture = runner.runCapture;
      runner.runCapture = () => '{"data":[{"id":"zai-org/GLM-5"}]}';

      try {
        assert.equal(nim.resolveRunningNimModel("z-ai/glm5"), "zai-org/GLM-5");
      } finally {
        runner.runCapture = originalRunCapture;
      }
    });
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      assert.equal(st.running, false);
    });
  });
});
