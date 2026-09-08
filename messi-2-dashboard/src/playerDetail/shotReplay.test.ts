import { describe, it, expect } from "vitest";
import * as THREE from "three";
import type { ShotmapPoint } from "../dashboard/types";
import { canReplayGoal, cloneReplayBall, replayPosition, styleShotBall, SHOT_BALL_COLORS } from "./shotReplay";
import { pitchPercentToWorld, trajectoryWorldPoints } from "./pitchWebglGeometry";

const goal = {x:87,y:48,outcome:"goal",trajectory:{endpointKind:"goal_mouth",endX:100,endY:51,endZMeters:.06}} as ShotmapPoint;
describe("asset goal replay",()=>{
 it('uses distinct opaque outcome colours while preserving the football texture',()=>{
  expect(new Set(Object.values(SHOT_BALL_COLORS)).size).toBe(4);
  for(const outcome of Object.keys(SHOT_BALL_COLORS) as ShotmapPoint['outcome'][]){
   const map=new THREE.Texture(),material=new THREE.MeshStandardMaterial({map,transparent:true,opacity:.25});
   const ball=new THREE.Mesh(new THREE.SphereGeometry(),material);
   styleShotBall(ball,outcome);
   expect(material.color.getHex()).toBe(SHOT_BALL_COLORS[outcome]);
   expect(material.opacity).toBe(1);expect(material.transparent).toBe(false);expect(material.depthWrite).toBe(true);
   expect(material.map).toBe(map);
   ball.geometry.dispose();material.dispose();map.dispose();
  }
 });
 it("requires a goal or on-target shot with in-frame endpoint, never fabricates missing height",()=>{
  expect(canReplayGoal(goal)).toBe(true);
  expect(canReplayGoal({...goal,outcome:"on_target"})).toBe(true);
  expect(canReplayGoal({...goal,outcome:"off_target"})).toBe(false);
  expect(canReplayGoal({...goal,outcome:"on_target",trajectory:{...goal.trajectory!,endZMeters:null}})).toBe(false);
  expect(canReplayGoal({...goal,outcome:"blocked"})).toBe(false);
  expect(canReplayGoal({...goal,trajectory:{...goal.trajectory!,endZMeters:null}})).toBe(false);
  expect(canReplayGoal({...goal,trajectory:{...goal.trajectory!,endY:99}})).toBe(false);
 });
 it("preserves exact endpoint height including below legacy .15m clamp",()=>{
  const end=pitchPercentToWorld({x:100,y:51},.06);
  expect(replayPosition(goal,1).toArray()).toEqual([end.x,end.y,end.z]);
  expect(replayPosition(goal,-5).toArray()).toEqual(replayPosition(goal,0).toArray());
  expect(replayPosition(goal,4).toArray()).toEqual(replayPosition(goal,1).toArray());
 });
 it("preserves an exact endZMeters of 0, not just 0.06 — a ground-level arrival must not be floored",()=>{
  const grounded={...goal,trajectory:{...goal.trajectory!,endZMeters:0}};
  const end=pitchPercentToWorld({x:100,y:51},0);
  expect(replayPosition(grounded,1).toArray()).toEqual([end.x,end.y,end.z]);
 });
 it("does not mutate source observations",()=>{
  const before=JSON.stringify(goal);
  for(let i=0;i<=100;i++)expect(replayPosition(goal,i/100).toArray().every(Number.isFinite)).toBe(true);
  expect(JSON.stringify(goal)).toBe(before);
 });
 it("draws the same arc as the static trajectory line, never a diverging path",()=>{
  const segments=24;
  const line=trajectoryWorldPoints(goal,goal.trajectory!.endY,goal.trajectory!.endZMeters,segments);
  for(let index=0;index<=segments;index++){
   const point=replayPosition(goal,index/segments);
   expect(point.x).toBeCloseTo(line[index].x);
   expect(point.y).toBeCloseTo(line[index].y);
   expect(point.z).toBeCloseTo(line[index].z);
  }
 });
 it("uses named asset geometry and preserves source visibility and geometry",()=>{
  const asset=new THREE.Group(),football=new THREE.Group();football.name="Football_13";football.visible=false;
  const original=new THREE.Mesh(new THREE.SphereGeometry(10),new THREE.MeshStandardMaterial());football.add(original);asset.add(football);
  const ball=cloneReplayBall(asset);ball.geometry.computeBoundingBox();
  expect(ball.geometry.boundingBox!.getSize(new THREE.Vector3()).x).toBeCloseTo(.22);
  expect(ball.geometry).not.toBe(original.geometry);expect(ball.visible).toBe(true);expect(football.visible).toBe(false);
  expect(()=>cloneReplayBall(new THREE.Group())).toThrow();
 });
});
