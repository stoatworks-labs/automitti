// Connect with the BMD SDK, list inputs + tally, then set preview/cut/auto on ME1 and watch tally callbacks.
#include "BMDSwitcherAPI.h"
#include <CoreFoundation/CoreFoundation.h>
#include <cstdio>
#include <vector>
#include <unistd.h>
#include <cstdlib>
static void dump(std::vector<IBMDSwitcherInput*>& ins, const char* tag) {
  printf("-- %s:", tag);
  for (auto* in : ins) { BMDSwitcherInputId id; bool p=false,v=false; in->GetInputId(&id); in->IsProgramTallied(&p); in->IsPreviewTallied(&v);
    if (p||v) printf(" %lld[%s%s]", (long long)id, p?"PGM":"", v?"PVW":""); }
  printf("\n"); fflush(stdout);
}
struct CB : public IBMDSwitcherInputCallback {
  BMDSwitcherInputId id;
  HRESULT QueryInterface(REFIID, LPVOID*) override { return E_NOINTERFACE; }
  ULONG AddRef() override { return 1; } ULONG Release() override { return 1; }
  HRESULT Notify(BMDSwitcherInputEventType t) override {
    if (t == bmdSwitcherInputEventTypeIsProgramTalliedChanged || t == bmdSwitcherInputEventTypeIsPreviewTalliedChanged)
      printf("   callback input %lld %s\n", (long long)id, t == bmdSwitcherInputEventTypeIsProgramTalliedChanged ? "ipgt" : "iprt");
    return S_OK; }
};
static void pump(double s){ CFRunLoopRunInMode(kCFRunLoopDefaultMode, s, false); }
int main(int argc, char** argv) {
  IBMDSwitcherDiscovery* disc = CreateBMDSwitcherDiscoveryInstance();
  IBMDSwitcher* sw = nullptr; BMDSwitcherConnectToFailure f;
  CFStringRef addr = CFStringCreateWithCString(nullptr, argc>1?argv[1]:"127.0.0.1", kCFStringEncodingUTF8);
  if (disc->ConnectTo(addr, &sw, &f) != S_OK) { printf("connect failed %08x\n", f); return 1; }
  IBMDSwitcherInputIterator* it = nullptr; sw->CreateIterator(IID_IBMDSwitcherInputIterator, (void**)&it);
  std::vector<IBMDSwitcherInput*> ins; IBMDSwitcherInput* in;
  while (it->Next(&in) == S_OK) { ins.push_back(in); auto* cb = new CB(); in->GetInputId(&cb->id); in->AddCallback(cb); }
  printf("inputs: %zu\n", ins.size());
  dump(ins, "initial");
  IBMDSwitcherMixEffectBlockIterator* mit = nullptr; sw->CreateIterator(IID_IBMDSwitcherMixEffectBlockIterator, (void**)&mit);
  IBMDSwitcherMixEffectBlock* me = nullptr; mit->Next(&me);
  printf("SetPreviewInput(3)\n"); me->SetPreviewInput(3); pump(0.5); dump(ins, "after CPvI");
  printf("PerformCut\n"); me->PerformCut(); pump(0.5); dump(ins, "after DCut");
  printf("SetPreviewInput(4)+PerformAutoTransition\n"); me->SetPreviewInput(4); me->PerformAutoTransition(); pump(1.0); dump(ins, "after DAut");
  BMDSwitcherInputId pg=0, pv=0; me->GetProgramInput(&pg); me->GetPreviewInput(&pv); printf("ME: program=%lld preview=%lld\n", (long long)pg, (long long)pv);
  pump(argc>2?atof(argv[2]):1.5);
  return 0;
}
