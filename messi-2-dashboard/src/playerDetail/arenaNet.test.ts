import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createArenaNet } from "./arenaNet";

describe("arena goal net", () => {
  it("replaces the disappearing texture alpha with world-space antialiased ropes", () => {
    const net = createArenaNet();
    expect(net.map).toBeNull();
    expect(net.side).toBe(THREE.DoubleSide);
    expect(net.transparent).toBe(true);
    expect(net.depthWrite).toBe(false);
    const shader = { vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <alphatest_fragment>", uniforms: {} };
    net.onBeforeCompile(shader as Parameters<typeof net.onBeforeCompile>[0], {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("modelMatrix*vec4(position,1.0)");
    expect(shader.fragmentShader).toContain("fwidth(netGrid)");
    expect(shader.fragmentShader).toContain("netMetres/.12");
    expect(shader.fragmentShader).toContain("discard");
    net.dispose();
  });
});
