// pj-braw — tiny Blackmagic RAW helper for photos.jpeg.
//   pj-braw <clip.braw> --info     → prints {"width":…,"height":…,"fps":…,"frames":…} as JSON
//   pj-braw <clip.braw> --decode   → writes every frame as 8-bit RGBA to stdout (pipe into ffmpeg)
// Built against the free Blackmagic RAW SDK (https://www.blackmagicdesign.com/developer/product/camera).
// Decodes with the clip's own metadata (as-shot white balance, ISO, Blackmagic Design Film/Video gamma).
#include "BlackmagicRawAPI.h"
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

#if defined(__APPLE__)
  typedef CFStringRef PJString;
  static PJString makeString(const char* s) { return CFStringCreateWithCString(kCFAllocatorDefault, s, kCFStringEncodingUTF8); }
  static void freeString(PJString s) { CFRelease(s); }
#elif defined(_WIN32)
  typedef BSTR PJString;
  static PJString makeString(const char* s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
    std::wstring w(n, L'\0'); MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], n);
    return SysAllocString(w.c_str());
  }
  static void freeString(PJString s) { SysFreeString(s); }
#else
  typedef const char* PJString;
  static PJString makeString(const char* s) { return s; }
  static void freeString(PJString) {}
#endif

static std::mutex gLock;
static std::condition_variable gCv;
static std::atomic<int> gInFlight{0};
static std::atomic<bool> gFailed{false};

class Callback : public IBlackmagicRawCallback {
 public:
  void ReadComplete(IBlackmagicRawJob* readJob, HRESULT result, IBlackmagicRawFrame* frame) override {
    IBlackmagicRawJob* decodeJob = nullptr;
    if (result == S_OK) result = frame->SetResourceFormat(blackmagicRawResourceFormatRGBAU8);
    if (result == S_OK) result = frame->CreateJobDecodeAndProcessFrame(nullptr, nullptr, &decodeJob);
    if (result == S_OK) result = decodeJob->Submit();
    if (result != S_OK) {
      if (decodeJob) decodeJob->Release();
      gFailed = true; done();
    }
    readJob->Release();
  }
  void ProcessComplete(IBlackmagicRawJob* job, HRESULT result, IBlackmagicRawProcessedImage* image) override {
    if (result == S_OK) {
      void* data = nullptr; uint32_t size = 0;
      image->GetResource(&data);
      image->GetResourceSizeBytes(&size);
      if (data && size) {
        std::lock_guard<std::mutex> g(gLock);
        if (fwrite(data, 1, size, stdout) != size) gFailed = true;
      }
    } else gFailed = true;
    job->Release();
    done();
  }
  void DecodeComplete(IBlackmagicRawJob*, HRESULT) override {}
  void TrimProgress(IBlackmagicRawJob*, float) override {}
  void TrimComplete(IBlackmagicRawJob*, HRESULT) override {}
  void SidecarMetadataParseWarning(IBlackmagicRawClip*, PJString, uint32_t, PJString) override {}
  void SidecarMetadataParseError(IBlackmagicRawClip*, PJString, uint32_t, PJString) override {}
  void PreparePipelineComplete(void*, HRESULT) override {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID*) override { return E_NOTIMPL; }
  ULONG STDMETHODCALLTYPE AddRef() override { return 0; }
  ULONG STDMETHODCALLTYPE Release() override { return 0; }
 private:
  static void done() { gInFlight--; gCv.notify_all(); }
};

int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "usage: pj-braw <clip.braw> --info|--decode\n"); return 2; }
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
#endif
  const bool info = strcmp(argv[2], "--info") == 0;
  IBlackmagicRawFactory* factory = nullptr;
#if defined(__APPLE__)
  // The SDK library is looked for next to this binary first, then in the SDK's default install location.
  const char* libDirs[] = { getenv("PJ_BRAW_LIB"), ".", "/Applications/Blackmagic RAW/Blackmagic RAW SDK/Mac/Libraries" };
  for (const char* d : libDirs) {
    if (!d) continue;
    PJString s = makeString(d);
    factory = CreateBlackmagicRawFactoryInstanceFromPath(s);
    freeString(s);
    if (factory) break;
  }
#else
  factory = CreateBlackmagicRawFactoryInstance();
#endif
  if (!factory) { fprintf(stderr, "Blackmagic RAW SDK library not found\n"); return 1; }
  IBlackmagicRaw* codec = nullptr;
  IBlackmagicRawClip* clip = nullptr;
  if (factory->CreateCodec(&codec) != S_OK) { fprintf(stderr, "CreateCodec failed\n"); return 1; }
  PJString path = makeString(argv[1]);
  HRESULT hr = codec->OpenClip(path, &clip);
  freeString(path);
  if (hr != S_OK) { fprintf(stderr, "Could not open clip\n"); return 1; }
  uint32_t width = 0, height = 0; uint64_t frames = 0; float fps = 0;
  clip->GetWidth(&width); clip->GetHeight(&height); clip->GetFrameCount(&frames); clip->GetFrameRate(&fps);
  if (info) {
    printf("{\"width\":%u,\"height\":%u,\"fps\":%.6g,\"frames\":%llu}\n", width, height, fps, (unsigned long long)frames);
    clip->Release(); codec->Release(); factory->Release();
    return 0;
  }
  Callback cb;
  codec->SetCallback(&cb);
  // Frames are submitted one at a time so they reach stdout in order; the SDK parallelizes inside each decode.
  for (uint64_t i = 0; i < frames && !gFailed; i++) {
    IBlackmagicRawJob* job = nullptr;
    if (clip->CreateJobReadFrame(i, &job) != S_OK) { gFailed = true; break; }
    gInFlight++;
    if (job->Submit() != S_OK) { job->Release(); gInFlight--; gFailed = true; break; }
    std::unique_lock<std::mutex> lk(gLock);
    gCv.wait(lk, [] { return gInFlight.load() == 0; });
  }
  codec->FlushJobs();
  fflush(stdout);
  clip->Release(); codec->Release(); factory->Release();
  return gFailed ? 1 : 0;
}
