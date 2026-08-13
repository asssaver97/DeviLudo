#include <ntddk.h>
#include <wdf.h>
#include <vhf.h>
#include <hidport.h>
#include <ntstrsafe.h>
#include "../Public.h"

// VHF is a kernel WDM/KMDF API. The signed golden-image driver therefore uses
// KMDF (not the unsupported UMDF/VHF combination) and exposes only one
// administrator-writable IOCTL for complete, bounded input reports.

typedef struct _DEVICE_CONTEXT { VHFHANDLE VhfHandle; } DEVICE_CONTEXT, *PDEVICE_CONTEXT;
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(DEVICE_CONTEXT, DeviceGetContext);

DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD DeviludoEvtDeviceAdd;
EVT_WDF_OBJECT_CONTEXT_CLEANUP DeviludoEvtDeviceCleanup;
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL DeviludoEvtIoDeviceControl;

static UCHAR GamepadReportDescriptor[] = {
  0x05,0x01, 0x09,0x05, 0xA1,0x01, 0x85,0x01,
  0x05,0x09, 0x19,0x01, 0x29,0x10, 0x15,0x00, 0x25,0x01,
  0x75,0x01, 0x95,0x10, 0x81,0x02,
  0x05,0x01, 0x09,0x30, 0x09,0x31, 0x09,0x33, 0x09,0x34,
  0x16,0x01,0x80, 0x26,0xFF,0x7F, 0x75,0x10, 0x95,0x04, 0x81,0x02,
  0x09,0x32, 0x09,0x35, 0x15,0x00, 0x27,0xFF,0xFF,0x00,0x00,
  0x75,0x10, 0x95,0x02, 0x81,0x02, 0xC0
};

NTSTATUS DriverEntry(PDRIVER_OBJECT DriverObject, PUNICODE_STRING RegistryPath) {
  WDF_DRIVER_CONFIG config;
  WDF_DRIVER_CONFIG_INIT(&config, DeviludoEvtDeviceAdd);
  return WdfDriverCreate(DriverObject, RegistryPath, WDF_NO_OBJECT_ATTRIBUTES, &config, WDF_NO_HANDLE);
}

NTSTATUS DeviludoEvtDeviceAdd(WDFDRIVER Driver, PWDFDEVICE_INIT DeviceInit) {
  UNREFERENCED_PARAMETER(Driver);
  NTSTATUS status;
  WDFDEVICE device;
  WDF_OBJECT_ATTRIBUTES attributes;
  WDF_IO_QUEUE_CONFIG queueConfig;
  UNICODE_STRING deviceName, symbolicLink, security;
  VHF_CONFIG vhfConfig;

  RtlInitUnicodeString(&deviceName, DEVILUDO_VHF_DEVICE_NAME);
  RtlInitUnicodeString(&symbolicLink, DEVILUDO_VHF_SYMBOLIC_LINK);
  RtlInitUnicodeString(&security, L"D:P(A;;GA;;;SY)(A;;GA;;;BA)");
  status = WdfDeviceInitAssignName(DeviceInit, &deviceName);
  if (!NT_SUCCESS(status)) return status;
  status = WdfDeviceInitAssignSDDLString(DeviceInit, &security);
  if (!NT_SUCCESS(status)) return status;
  WdfDeviceInitSetDeviceType(DeviceInit, FILE_DEVICE_UNKNOWN);
  WdfDeviceInitSetExclusive(DeviceInit, TRUE);

  WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, DEVICE_CONTEXT);
  attributes.EvtCleanupCallback = DeviludoEvtDeviceCleanup;
  status = WdfDeviceCreate(&DeviceInit, &attributes, &device);
  if (!NT_SUCCESS(status)) return status;
  status = WdfDeviceCreateSymbolicLink(device, &symbolicLink);
  if (!NT_SUCCESS(status)) return status;

  PDEVICE_CONTEXT context = DeviceGetContext(device);
  context->VhfHandle = NULL;
  VHF_CONFIG_INIT(&vhfConfig, WdfDeviceWdmGetDeviceObject(device),
    (USHORT)sizeof(GamepadReportDescriptor), GamepadReportDescriptor);
  vhfConfig.VendorID = 0x1209;
  vhfConfig.ProductID = 0xD311;
  vhfConfig.VersionNumber = 1;
  status = VhfCreate(&vhfConfig, &context->VhfHandle);
  if (!NT_SUCCESS(status)) return status;
  status = VhfStart(context->VhfHandle);
  if (!NT_SUCCESS(status)) return status;

  WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queueConfig, WdfIoQueueDispatchSequential);
  queueConfig.EvtIoDeviceControl = DeviludoEvtIoDeviceControl;
  return WdfIoQueueCreate(device, &queueConfig, WDF_NO_OBJECT_ATTRIBUTES, WDF_NO_HANDLE);
}

VOID DeviludoEvtDeviceCleanup(WDFOBJECT DeviceObject) {
  PDEVICE_CONTEXT context = DeviceGetContext((WDFDEVICE)DeviceObject);
  if (context->VhfHandle != NULL) { VhfDelete(context->VhfHandle, TRUE); context->VhfHandle = NULL; }
}

VOID DeviludoEvtIoDeviceControl(WDFQUEUE Queue, WDFREQUEST Request, size_t OutputBufferLength,
  size_t InputBufferLength, ULONG IoControlCode) {
  UNREFERENCED_PARAMETER(OutputBufferLength);
  NTSTATUS status = STATUS_INVALID_DEVICE_REQUEST;
  if (IoControlCode == IOCTL_DEVILUDO_VHF_SUBMIT_REPORT && InputBufferLength == sizeof(DEVILUDO_GAMEPAD_REPORT)) {
    PDEVILUDO_GAMEPAD_REPORT report = NULL;
    status = WdfRequestRetrieveInputBuffer(Request, sizeof(*report), (PVOID *)&report, NULL);
    if (NT_SUCCESS(status) && report->ReportId == 1) {
      HID_XFER_PACKET packet = {0};
      packet.reportBuffer = (PUCHAR)report;
      packet.reportBufferLen = sizeof(*report);
      packet.reportId = report->ReportId;
      status = VhfReadReportSubmit(DeviceGetContext(WdfIoQueueGetDevice(Queue))->VhfHandle, &packet);
    } else if (NT_SUCCESS(status)) status = STATUS_INVALID_PARAMETER;
  }
  WdfRequestComplete(Request, status);
}
