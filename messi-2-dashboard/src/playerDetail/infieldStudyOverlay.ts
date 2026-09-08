import * as THREE from 'three';
import { fetchPlayerDetail } from '../api/leaderboardsApi';
import { fetchFullActivityHeatmap } from '../api/fullActivityHeatmapApi';
import { buildGroundDensityDots, createContinuousGroundHeatmap, createGroundHeatmap, highDensityAccents } from './groundHeatmap';
import { pitchPercentToWorld } from './pitchWebglGeometry';
import { canReplayGoal, cloneReplayBall, replayPosition, styleShotBall } from './shotReplay';

/** Local art-direction study only. Same validated APIs and transforms as the product. */
export async function createInfieldStudyOverlay(asset: THREE.Object3D, baseUrl: string) {
  const context = { playerId: 194165, season: '2025/2026', mode: 'league' as const, scope: 8 as const, competition: 'all' as const };
  const config = { baseUrl, season: context.season, scope: context.scope, limit: 1000 };
  const state = { ...context, page: 1, pageSize: 50 as const, sort: 'score' as const, direction: 'desc' as const };
  const signal = AbortSignal.timeout(60000);
  const [detail, heat] = await Promise.all([
    fetchPlayerDetail(config, context.playerId, state, signal),
    fetchFullActivityHeatmap(config, context, signal),
  ]);
  if (heat.context.playerId !== context.playerId || heat.context.season !== context.season ||
      heat.context.mode !== context.mode || heat.context.scope !== context.scope || heat.context.competition !== null) {
    throw new Error('Study heatmap context mismatch');
  }
  if (!heat.data.available || !detail.analysis?.spatial.shotmapSnapshotAvailable) throw new Error('Study spatial data unavailable');
  const shots = detail.analysis.spatial.shotmapPoints;
  const selected = shots.find(shot => canReplayGoal(shot) && shot.x >= 78 && shot.x < 88 && shot.y >= 35 && shot.y <= 65) ?? shots.find(canReplayGoal);
  if (!selected) throw new Error('No endpoint-backed shot available for study replay');
  const group = new THREE.Group();
  group.name = 'actual-data-study-overlay';
  group.add(createContinuousGroundHeatmap(heat.data.cellCounts));
  group.add(createGroundHeatmap(highDensityAccents(buildGroundDensityDots(heat.data.cellCounts))));
  for (const shot of shots) {
    if (shot === selected) continue;
    const ball = cloneReplayBall(asset);
    styleShotBall(ball, shot.outcome);
    const point = pitchPercentToWorld(shot, .18);
    ball.position.set(point.x, point.y, point.z);
    // Display magnification is not a measured ball diameter.
    ball.scale.setScalar(1.6);
    group.add(ball);
  }
  const path = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 65 }, (_, i) => replayPosition(selected, i / 64)));
  group.add(new THREE.Line(path, new THREE.LineBasicMaterial({ color: 0xd9fff5, toneMapped: false })));
  const ball = cloneReplayBall(asset); styleShotBall(ball, selected.outcome); ball.scale.setScalar(1.6); group.add(ball);
  const ring = new THREE.Mesh(new THREE.RingGeometry(.4, .46, 48), new THREE.MeshBasicMaterial({ color: 0x9ef6df, side: THREE.DoubleSide, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = .02; group.add(ring);
  // The selected shot has one ball only; its ground-projected ring follows that ball.
  const update = (progress: number) => { ball.position.copy(replayPosition(selected, progress)); ball.rotation.x = progress * Math.PI * 6; ring.position.x = ball.position.x; ring.position.z = ball.position.z; };
  update(.45);
  return { group, update, shotCount: shots.length, validPointCount: heat.data.validPointCount,
    label: `${detail.player.name} · ${context.season} · league / scope 8 · ${shots.length}슛 · 활동 ${heat.data.validPointCount.toLocaleString()}점`,
    selectedLabel: `선택 ${selected.outcome === 'goal' ? '득점' : '유효슛'} · xG ${selected.xg == null ? '미제공' : selected.xg.toFixed(2)} · 궤적 중간 높이·시간은 설명용`,
  };
}
