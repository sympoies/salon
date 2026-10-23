/** Component-only seam for delayed/failed LOCAL journal persistence.
 * Real journal, request identity and HTTP behavior are covered by
 * sharedOutboxClient.test.ts. This fixture never models provider delivery.
 */
export function sharedAdmissionFixture(persistExpression: string): string {
  return `
    let nextId=0;
    const client={
      targets:()=>[],retainedEdits:()=>[],error:()=>undefined,
      enqueue:async(session,text)=>{
        const result=await (${persistExpression})(session.machine,session.id,{text,expected_session_incarnation:session.session_incarnation});
        if(!result.ok)throw Error(result.error??'Could not save the reply. Your draft has been kept.');
        return 'fixture-admission-'+(++nextId);
      }
    };
    export const usesSharedOutbox=session=>Boolean(session.session_incarnation)&&['claude','codex'].includes(session.provider_resume?.provider??session.agent);
    export const useSharedOutbox=()=>client;
    export const sharedOutboxClient=()=>client;
    export const useSharedOutboxSync=()=>{};
  `;
}
