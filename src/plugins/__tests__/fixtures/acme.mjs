// A test plugin for the plugin seam, as one self-contained file (no package.json):
// one block, one rule, one scaffold, one gate check. Generic on purpose:
// "acme" and "widget" stand for any plugin and block.
const files=(w,g)=>[...(w.length?[{path:".claude/acme/widget.json",content:JSON.stringify(w,null,2)+"\n"},{path:".claude/acme/hook.sh",content:"#!/usr/bin/env bash\nexit 0\n",executable:true}]:[]),...(g.length?[{path:".claude/acme/check.sh",content:"#!/usr/bin/env bash\n# acme gate check\nexit 0\n",executable:true}]:[])];
export default{id:"acme",version:"1.0.0",apiVersion:1,blocks:{widget:{multiplicity:"repeated",fields:["a","b"]}},
validate(d){return(d.widget??[]).filter(w=>!w.a).map(w=>({rule:"acme/widget-needs-a",level:"error",message:`widget ${w.id??"(no id)"} has no a:`,...(w.id?{node:w.id}:{})}))},
scaffold:{"claude-code":(d,v)=>{const w=d.widget??[],g=v.nodes.filter(n=>n.type==="gate"&&n.extensions&&n.extensions.acme);return{files:files(w,g),settingsHooks:w.length?{PreToolUse:[{matcher:"Bash",hooks:[{type:"command",command:'bash "$CLAUDE_PROJECT_DIR/.claude/acme/hook.sh"'}]}]}:{},gateRuns:Object.fromEntries(g.map(x=>[x.id,"bash .claude/acme/check.sh"]))}}}};
