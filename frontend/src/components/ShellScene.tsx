"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export default function ShellScene({ picking, revealed }: { picking: boolean; revealed: number }) {
  const root = useRef<HTMLDivElement>(null);
  const state = useRef({ picking, revealed });
  const invalidate = useRef(() => {});

  useEffect(() => {
    state.current = { picking, revealed };
    invalidate.current();
  }, [picking, revealed]);

  useEffect(() => {
    const layer = root.current;
    const felt = layer?.parentElement;
    if (!layer || !felt) return;
    const buttons = [...felt.querySelectorAll<HTMLButtonElement>(".cup")];
    if (buttons.length !== 3) return;

    let renderer: THREE.WebGLRenderer;
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2", { alpha: true, antialias: true });
      if (!context) return;
      renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true, antialias: true });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1200);
    camera.position.z = 600;
    const generator = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = generator.fromScene(room, 0.08);
    room.dispose();
    generator.dispose();
    scene.environment = environment.texture;
    const light = new THREE.DirectionalLight(0xffe4bf, 3);
    light.position.set(-150, 200, 400);
    scene.add(light);

    const body = new THREE.LatheGeometry(
      [
        [0, 1.22],
        [0.41, 1.22],
        [0.46, 1.17],
        [0.62, 0.12],
        [0.65, 0.07],
        [0.63, 0.02],
        [0.57, 0.02],
        [0.4, 1.12],
        [0, 1.12],
      ]
        .reverse()
        .map(([x, y]) => new THREE.Vector2(x, y)),
      48,
    );
    const metal = new THREE.MeshStandardMaterial({ color: 0xc38d56, metalness: 0.74, roughness: 0.32 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xffca50, metalness: 0.38, roughness: 0.23 });
    const ballGeometry = new THREE.SphereGeometry(0.17, 24, 16);
    const cups = buttons.map(() => new THREE.Mesh(body, metal));
    const ball = new THREE.Mesh(ballGeometry, gold);
    scene.add(...cups, ball);

    const points = buttons.map(() => new THREE.Vector2());
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let scale = 1;
    let started = 0;
    let wasPicking = false;
    let last = 0;
    const target = new THREE.Vector3();

    function schedule() {
      if (!frame) frame = requestAnimationFrame(render);
    }

    function render(now: number) {
      frame = 0;
      const { picking, revealed } = state.current;
      if (picking && !wasPicking) started = now;
      wasPicking = picking;
      const time = picking && !reduceMotion.matches ? Math.min((now - started) / 520, 1) : 1;
      const ease = reduceMotion.matches ? 1 : 1 - Math.exp(-Math.min(now - last, 40) / 65);
      last = now;
      let moving = time < 1;
      cups.forEach((cup, index) => {
        const point = points[index];
        const lift = revealed === index;
        const shuffle = Math.sin(time * Math.PI * 2) * (1 - time) * scale;
        target.set(
          point.x - (index - 1) * shuffle * 0.68,
          point.y + (lift ? 0.64 * scale : 0) + Math.abs(shuffle) * 0.2,
          0,
        );
        cup.position.lerp(target, ease);
        cup.rotation.set(lift ? 0.66 : 0.48, 0, lift ? -0.16 : 0);
        moving ||= cup.position.distanceToSquared(target) > 0.08;
      });
      ball.visible = !!points[revealed];
      if (ball.visible) {
        ball.position.set(points[revealed].x, points[revealed].y + scale * 0.04, 42);
        ball.scale.setScalar(THREE.MathUtils.lerp(ball.scale.x, scale, ease));
        moving ||= Math.abs(ball.scale.x - scale) > 0.15;
      } else ball.scale.setScalar(0.01);
      renderer.render(scene, camera);
      if (moving) schedule();
    }

    const resize = () => {
      const box = layer.getBoundingClientRect();
      if (!box.width || !box.height) return;
      camera.left = -box.width / 2;
      camera.right = box.width / 2;
      camera.top = box.height / 2;
      camera.bottom = -box.height / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(box.width, box.height, false);
      buttons.forEach((button, index) => {
        const rect = button.getBoundingClientRect();
        points[index].set(
          rect.left + rect.width / 2 - box.left - box.width / 2,
          box.top + box.height / 2 - rect.top - rect.height * 0.82,
        );
        scale = Math.min(rect.width * 0.65, rect.height * 0.65);
        cups[index].scale.setScalar(scale);
        cups[index].position.set(points[index].x, points[index].y, 0);
      });
      schedule();
    };

    const lost = (event: Event) => {
      event.preventDefault();
      felt.classList.remove("has-webgl");
    };
    const restored = () => {
      felt.classList.add("has-webgl");
      schedule();
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    renderer.domElement.addEventListener("webglcontextrestored", restored);
    layer.append(renderer.domElement);
    felt.classList.add("has-webgl");
    invalidate.current = schedule;
    const observer = new ResizeObserver(resize);
    observer.observe(layer);
    resize();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      invalidate.current = () => {};
      felt.classList.remove("has-webgl");
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      renderer.domElement.removeEventListener("webglcontextrestored", restored);
      renderer.domElement.remove();
      for (const resource of [renderer, body, metal, gold, ballGeometry, environment]) resource.dispose();
    };
  }, []);

  return <div ref={root} className="shell-canvas" aria-hidden="true" />;
}
