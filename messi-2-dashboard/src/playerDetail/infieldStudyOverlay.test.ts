import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { fetchPlayerDetail } from '../api/leaderboardsApi';
import { fetchFullActivityHeatmap } from '../api/fullActivityHeatmapApi';
import { createInfieldStudyOverlay } from './infieldStudyOverlay';

vi.mock('../api/leaderboardsApi', () => ({ fetchPlayerDetail: vi.fn() }));
vi.mock('../api/fullActivityHeatmapApi', () => ({ fetchFullActivityHeatmap: vi.fn() }));

const shot = { x: 82, y: 50, outcome: 'goal', xg: .24, trajectory: { endpointKind: 'goal_mouth', endX: 100, endY: 50, endZMeters: 1 } };
const heat = () => ({ context: { playerId: 194165, season: '2025/2026', mode: 'league', scope: 8, competition: null }, data: { available: true, cellCounts: Array.from({ length: 704 }, (_, i) => i === 600 ? 10 : 0), validPointCount: 10 } });
const asset = () => {
  const root = new THREE.Group(); const ball = new THREE.Mesh(new THREE.SphereGeometry(.11), new THREE.MeshStandardMaterial());
  ball.name = 'Football_13'; root.add(ball); return root;
};
beforeEach(() => {
  vi.mocked(fetchPlayerDetail).mockResolvedValue({ player: { name: 'Fixture player' }, analysis: { spatial: { shotmapSnapshotAvailable: true, shotmapPoints: [shot] } } } as never);
  vi.mocked(fetchFullActivityHeatmap).mockResolvedValue(heat() as never);
});
describe('local actual-data overlay', () => {
  it('uses matching API contexts and preserves the shot while advancing replay to its endpoint', async () => {
    const before = JSON.stringify(shot); const result = await createInfieldStudyOverlay(asset(), 'https://example.test');
    expect(fetchFullActivityHeatmap).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ playerId: 194165, season: '2025/2026', scope: 8 }), expect.any(AbortSignal));
    expect(result.shotCount).toBe(1); expect(result.validPointCount).toBe(10);
    expect(result.selectedLabel).toContain('설명용'); result.update(1);
    expect(JSON.stringify(shot)).toBe(before);
    const balls = result.group.children.filter(child => child.name === 'selected-shot-asset-football');
    expect(balls).toHaveLength(1); expect(balls[0].position.y).toBe(1);
    const ring = result.group.children.find(child => child instanceof THREE.Mesh && child.geometry instanceof THREE.RingGeometry)!;
    expect(ring.position.x).toBe(balls[0].position.x); expect(ring.position.z).toBe(balls[0].position.z);
    expect(result.group.getObjectByName('ground-density-dots-192x124')).toBeDefined();
  });
  it('refuses another season instead of overlaying mismatched data', async () => {
    const response = heat(); response.context.season = '2024/2025';
    vi.mocked(fetchFullActivityHeatmap).mockResolvedValue(response as never);
    await expect(createInfieldStudyOverlay(asset(), 'https://example.test')).rejects.toThrow('context mismatch');
  });
  it('refuses missing spatial data rather than substituting generated density', async () => {
    const response = heat(); response.data.available = false;
    vi.mocked(fetchFullActivityHeatmap).mockResolvedValue(response as never);
    await expect(createInfieldStudyOverlay(asset(), 'https://example.test')).rejects.toThrow('unavailable');
  });
});
