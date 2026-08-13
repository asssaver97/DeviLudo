#pragma once
#include <devioctl.h>

#define DEVILUDO_VHF_DEVICE_NAME L"\\Device\\DeviLudoVhfGamepad"
#define DEVILUDO_VHF_SYMBOLIC_LINK L"\\DosDevices\\DeviLudoVhfGamepad"
#define IOCTL_DEVILUDO_VHF_SUBMIT_REPORT CTL_CODE(FILE_DEVICE_UNKNOWN, 0x801, METHOD_BUFFERED, FILE_WRITE_DATA)

#pragma pack(push, 1)
typedef struct _DEVILUDO_GAMEPAD_REPORT {
  unsigned char ReportId;
  unsigned short Buttons;
  short LeftX;
  short LeftY;
  short RightX;
  short RightY;
  unsigned short LeftTrigger;
  unsigned short RightTrigger;
} DEVILUDO_GAMEPAD_REPORT, *PDEVILUDO_GAMEPAD_REPORT;
#pragma pack(pop)
