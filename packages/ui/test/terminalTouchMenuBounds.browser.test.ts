import { strict as assert } from "node:assert";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";

test("terminal clipboard targets fit the shared menu and pane at touch edges", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {TerminalPane} from '/src/TerminalPane.tsx';
    import * as touch from '/src/terminalTouch.ts';
    window.menuFixture={touch};
    createRoot(document.querySelector('#root')).render(React.createElement(TerminalPane,{machine:'fixture',id:'touch-bounds',agent:'shell',showKeyBar:false}));
  `;
  const adapter = `
    export const BASE_TERMINAL_FONT_SIZE=14;
    export function createTerminalInstance(host,deps){
      deps.termRef.current={focus(){},blur(){},hasSelection(){return true;},getSelection(){return 'selected command';}};
      window.menuFixture.open=(point)=>{
        const pane=deps.paneRef.current,rect=pane.getBoundingClientRect(),touch=window.menuFixture.touch;
        const height=touch.terminalTouchMenuHeight(pane);
        const width=Math.min(406,rect.width-16);
        deps.setTerminalTouchMenu({key:deps.terminalInstanceKey,...touch.terminalTouchMenuPosition(rect.left+point[0],rect.top+point[1],rect,{width,height}),width,hasSelection:true,linkUrl:null,links:[],revision:1});
      };
      return ()=>{deps.termRef.current=null;};
    }
  `;
  const bundle = await build({ root: new URL("..", import.meta.url).pathname, configFile:false, logLevel:"silent",
    define:{"process.env.NODE_ENV":JSON.stringify("production")}, plugins:[react(),{
      name:"touch-menu-consumer-fixture", enforce:"pre",
      resolveId(id, importer){
        if(id.endsWith("touch-menu-fixture"))return "\0touch-menu-fixture";
        if(id==="./terminalInstance.ts"&&importer?.includes("/src/"))return "\0touch-menu-adapter";
      },
      load(id){if(id==="\0touch-menu-fixture")return fixture;if(id==="\0touch-menu-adapter")return adapter;},
    }],build:{write:false,minify:false,lib:{entry:"touch-menu-fixture",name:"TouchFixture",formats:["iife"]}}});
  const output=Array.isArray(bundle)?bundle[0]:bundle;
  assert.ok(output&&"output"in output);
  const code=output.output.filter(x=>x.type==="chunk").map(x=>x.code).join("\n");
  for(const [width,coarse,point]of[[412,true,[8,8]],[412,true,[404,292]],[412,true,[206,150]],[1280,false,[1272,292]]]as const){
    await t.test(`${width}px ${coarse?"coarse":"fine"} at ${point}`,()=>{
      const m=measureUiMarkup<{error?:string;menu:number[];pane:number[];buttons:number[][];selected:boolean;targetHeight:number;hit:boolean}>(
        `<style>#root{height:300px}.terminal-pane{height:300px}</style><div id="root"></div><script>${code}</script>`,width,`
          const result={};let tries=80;
          function sample(){
            if(!window.menuFixture?.open){if(--tries)setTimeout(sample,20);return;}
            window.menuFixture.open(${JSON.stringify(point)});
            setTimeout(()=>{
              const menu=document.querySelector('.terminal-touch-menu'),pane=document.querySelector('.terminal-pane');
              const box=e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom];};
              const buttons=[...menu.querySelectorAll('button')],r=buttons[0].getBoundingClientRect();
              parent.document.querySelector('#measurement').textContent=JSON.stringify({viewportWidth:innerWidth,menu:box(menu),pane:box(pane),buttons:buttons.map(box),selected:buttons[0].title==='Copy selection',targetHeight:r.height,hit:document.elementFromPoint(r.left+r.width/2,r.top+1)===buttons[0]&&document.elementFromPoint(r.left+r.width/2,r.bottom-1)===buttons[0]});
            },50);
          }sample();
        `,false,800,coarse?["--blink-settings=primaryPointerType=2,availablePointerTypes=2"]:[]);
      assert.equal(m.selected,true,"actual selected-text consumer rendered");
      assert.equal(m.targetHeight,coarse?48:34,"shared menu target retained");
      assert.ok(m.buttons.length>=4,"actual clipboard actions are present");
      for(const b of m.buttons){
        assert.ok(b[0]!>=m.menu[0]!&&b[2]!<=m.menu[2]!,"button inside toolbar horizontally");
        assert.ok(b[1]!>=m.menu[1]!&&b[3]!<=m.menu[3]!,"button inside toolbar vertically");
      }
      assert.ok(m.menu[0]!>=m.pane[0]!+8&&m.menu[2]!<=m.pane[2]!-8,"toolbar inside horizontal pane edges");
      assert.ok(m.menu[1]!>=m.pane[1]!+8&&m.menu[3]!<=m.pane[3]!-8,"toolbar inside vertical pane edges");
      assert.equal(m.hit,true,"top and bottom of the selected Copy target remain hit-testable");
      console.log(JSON.stringify(m));
    });
  }
});
